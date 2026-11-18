import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { activeSources, validateSettings } from './sources.mjs';
import { categories, kinds, stages, canonicalUrl, plain } from './opportunities.mjs';
import { openStore } from './store.mjs';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);
const interval = Number(process.env.RADAR_INTERVAL_MINUTES ?? 30);
const port = Number(process.env.PORT ?? 4173);
const webKey = process.env.BRAVE_API_KEY?.trim();
if (!Number.isFinite(interval) || interval < 0 || (interval > 0 && interval < 5) || interval > 1440) {
  throw new Error('RADAR_INTERVAL_MINUTES deve ser 0 (manual) ou estar entre 5 e 1440.');
}
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT inválida.');

const store = openStore(resolve(process.env.RADAR_DATA_DIR ?? 'data', 'radar.sqlite'));
let running = false;
let progress = [];

function startScan() {
  if (running) return false;
  const sources = activeSources(store.settings(), webKey);
  if (!sources.length) throw new HttpError(400, 'Ative pelo menos uma fonte nos ajustes.');
  running = true;
  progress = sources.map(([source]) => ({ source, state: 'running' }));
  void (async () => {
    await Promise.all(sources.map(async ([source, fetchItems], index) => {
      try {
        const { items, warning } = await fetchItems();
        progress[index] = { source, state: warning ? 'partial' : 'ok', warning, ...store.save(items) };
      } catch (error) {
        progress[index] = { source, state: 'error', warning: plain(error.message, 180) };
      }
    }));
    store.set('scan', { at: new Date().toISOString(), sources: progress });
  })().catch(error => console.error('Falha ao registrar a coleta', error))
    .finally(() => { running = false; progress = []; });
  return true;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readJson(req) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new HttpError(415, 'Envie application/json.');
  }
  const chunks = [];
  let size = 0;
  for await (const bytes of req) {
    size += bytes.length;
    if (size > 256_000) throw new HttpError(413, 'O arquivo deve ter até 256 KB.');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks));
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

function fromImport(item) {
  if (!item || typeof item.title !== 'string' || !plain(item.title) || !canonicalUrl(item.url) ||
    !kinds.includes(item.kind) || !Array.isArray(item.categories) ||
    !item.categories.some(category => categories.includes(category))) {
    throw new HttpError(400, 'Cada registro precisa de título, link HTTP(S), tipo e categoria válida.');
  }
  return {
    title: item.title, url: item.url, kind: item.kind, categories: item.categories,
    description: item.description, source: item.source,
    organization: item.organization, language: item.language, publishedAt: item.publishedAt,
    manual: true, explicit: item.kind === 'freela',
    evidence: item.kind === 'freela' ? 'Anúncio importado pela equipe. Confira o link original.' :
      'Empresa registrada pela equipe. Confirme a necessidade antes do contato.',
    budget: item.budget,
  };
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function handle(req, res) {
  const expectedHost = `127.0.0.1:${server.address().port}`;
  if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`) ||
    req.headers['sec-fetch-site'] === 'cross-site') {
    throw new HttpError(403, 'Abra o painel pelo endereço local exibido no terminal.');
  }
  const path = req.url.split('?')[0];
  if (req.method === 'GET' && assets.has(path)) {
    const [file, contentType] = assets.get(path);
    const body = await readFile(new URL(`../public/${file}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(body);
    return;
  }
  if (req.method === 'GET' && path === '/api/state') {
    json(res, 200, { opportunities: store.list(), settings: store.settings(), scan: store.scan(),
      running, progress, interval, hasWebKey: Boolean(webKey) });
    return;
  }
  if (req.method === 'POST' && path === '/api/scan') {
    json(res, 202, { started: startScan() });
    return;
  }
  if (req.method === 'PUT' && path === '/api/settings') {
    const input = await readJson(req);
    let settings;
    try { settings = validateSettings(input, Boolean(webKey)); }
    catch (error) { throw new HttpError(400, error.message); }
    store.set('settings', settings);
    json(res, 200, settings);
    return;
  }
  if (req.method === 'POST' && path === '/api/opportunities') {
    const input = await readJson(req);
    const items = Array.isArray(input) ? input : [input];
    if (!items.length || items.length > 150) throw new HttpError(400, 'Importe de 1 a 150 registros por vez.');
    const result = store.save(items.map(fromImport));
    json(res, 201, result);
    return;
  }
  if (req.method === 'PATCH' && /^\/api\/opportunities\/[a-f0-9]{24}$/.test(path)) {
    const input = await readJson(req);
    if (!input || (input.stage === undefined && input.notes === undefined) ||
      (input.stage !== undefined && !stages.includes(input.stage)) ||
      (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 4000))) {
      throw new HttpError(400, 'Etapa ou anotação inválida.');
    }
    const record = store.edit(path.split('/').at(-1), input);
    if (!record) throw new HttpError(404, 'Oportunidade não encontrada.');
    json(res, 200, record);
    return;
  }
  throw new HttpError(404, 'Página não encontrada.');
}

const server = createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  void handle(req, res).catch(error => {
    if (!error.status) console.error(error);
    if (!res.headersSent) json(res, error.status ?? 500, { error: error.status ? error.message : 'Erro interno.' });
  });
});

function scheduledScan() {
  if (!interval || running || !activeSources(store.settings(), webKey).length) return;
  const at = store.scan()?.at;
  if (!at || Date.now() - new Date(at) >= interval * 60_000) startScan();
}

server.listen(port, '127.0.0.1', () => {
  console.log(`Radar Freela disponível em http://127.0.0.1:${server.address().port}`);
  if (interval) {
    scheduledScan();
    setInterval(scheduledScan, 30_000).unref();
  }
});
