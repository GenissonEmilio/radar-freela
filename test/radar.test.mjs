import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalUrl, asksForProject, toOpportunity } from '../src/opportunities.mjs';
import { openStore } from '../src/store.mjs';

const listing = {
  title: 'Aplicativo Android para gerenciar pedidos',
  url: 'https://example.com/mobile?utm_source=email',
  kind: 'freela',
  categories: ['Mobile'],
  source: 'Exemplo',
  budget: { min: 3000, max: 6000, currency: 'BRL' },
};

test('classifica demandas em português e inglês e rejeita links inseguros', () => {
  const record = toOpportunity({ ...listing, categories: [], description: 'Integrar com webhook do CRM' });
  assert.deepEqual(record.categories, ['Mobile', 'Integrações']);
  assert.equal(record.url, 'https://example.com/mobile');
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
  assert.equal(canonicalUrl('https://example.com@wrong.example/'), null);
  assert.equal(asksForProject('Looking for a full-time web developer'), false);
  assert.equal(asksForProject('We need a freelance web developer'), true);
  assert.equal(toOpportunity({ ...listing, title: 'Logo e identidade visual', categories: [] }), null);
});

test('preserva etapa e notas quando uma fonte repete a oportunidade', () => {
  const db = openStore(':memory:');
  try {
    assert.deepEqual(db.save([listing, listing]), { created: 1, matched: 1 });
    const [first] = db.list();
    db.edit(first.id, { stage: 'negociacao', notes: 'Orçamento em análise' });
    assert.deepEqual(db.save([{ ...listing, url: 'https://example.com/mobile/?fbclid=123', description: 'Escopo atualizado' }]),
      { created: 0, matched: 1 });
    const [again] = db.list();
    assert.equal(again.stage, 'negociacao');
    assert.equal(again.notes, 'Orçamento em análise');
    assert.equal(again.description, 'Escopo atualizado');
    assert.equal(again.firstSeen, first.firstSeen);
  } finally { db.close(); }
});

async function startServer(directory) {
  const child = spawn(process.execPath, ['src/server.mjs'], {
    env: { ...process.env, PORT: '0', RADAR_INTERVAL_MINUTES: '0', RADAR_DATA_DIR: directory },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errorOutput = '';
  child.stderr.on('data', buffer => { errorOutput += buffer; });
  const url = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Servidor não respondeu.'));
    }, 10_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Servidor encerrou ${code}: ${errorOutput}`)); });
    child.stdout.on('data', buffer => {
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(String(buffer));
      if (match) { clearTimeout(timeout); resolve(match[0]); }
    });
  });
  return {
    url,
    stop: () => new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill();
    }),
  };
}

test('cria registros, aplica configurações e carrega os dados após reiniciar', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'radar-freela-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const request = (server, path, method = 'GET', body) => fetch(server.url + path, {
    method, headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const first = await startServer(directory);
  try {
    assert.match(await (await request(first, '/')).text(), /Radar Freela/);
    assert.equal((await fetch(first.url + '/api/state', { headers: { Origin: 'https://example.com' } })).status, 403);
    assert.equal((await request(first, '/api/settings', 'PUT', { local: true, bounds: '0,0,90,90' })).status, 400);
    assert.equal((await request(first, '/api/settings', 'PUT', { marketplace: false, community: false })).status, 200);
    assert.equal((await request(first, '/api/scan', 'POST')).status, 400);
    assert.equal((await request(first, '/api/opportunities', 'POST', [{ ...listing, url: 'javascript:void(0)' }])).status, 400);
    const lead = { title: 'Clínica Teste', url: 'https://example.com/clinic', kind: 'prospeccao', categories: ['Web'] };
    const inserted = await request(first, '/api/opportunities', 'POST', [listing, lead, listing]);
    assert.equal(inserted.status, 201);
    assert.deepEqual(await inserted.json(), { created: 2, matched: 2 });
    const snapshot = await (await request(first, '/api/state')).json();
    const item = snapshot.opportunities.find(record => record.kind === 'freela');
    const update = await request(first, `/api/opportunities/${item.id}`, 'PATCH', { stage: 'avaliar', notes: 'Pedir detalhes' });
    assert.equal(update.status, 200);
  } finally { await first.stop(); }

  const restarted = await startServer(directory);
  try {
    const { opportunities, settings } = await (await request(restarted, '/api/state')).json();
    assert.equal(settings.marketplace, false);
    assert.equal(opportunities.length, 2);
    assert.equal(opportunities.find(item => item.kind === 'freela').notes, 'Pedir detalhes');
    assert.equal(opportunities.find(item => item.kind === 'freela').stage, 'avaliar');
  } finally { await restarted.stop(); }
});
