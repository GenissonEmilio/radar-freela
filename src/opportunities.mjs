import { createHash } from 'node:crypto';

export const categories = ['Web', 'Mobile', 'Desktop', 'Integrações'];
export const kinds = ['freela', 'prospeccao'];
export const stages = ['novo', 'avaliar', 'proposta', 'negociacao', 'fechado', 'descartado'];

const signals = {
  Web: /\b(html|wordpress|shopify|woocommerce|webflow|react\.js|next\.js|website|web app|web development|full stack|site institucional|criar um site|landing page|e-commerce|ecommerce|frontend|front-end|painel web|desenvolvimento web|redesign de site)\b/i,
  Mobile: /\b(mobile|android|ios|flutter|react native|swiftui|kotlin|app store|aplicativo|mobile app|app development)\b/i,
  Desktop: /\b(desktop|winforms|wpf|winui|electron|tauri|pyqt|tkinter|macos app|windows app|windows application|software para windows|aplicativo para pc)\b/i,
  Integrações: /\b(api|webhook|automacao|automation|integration|integracao|crm|erp|zapier|n8n|backend|back-end|software development|software architecture|custom software|sistema sob medida)\b/i,
};
const intent = /\b(looking for|looking to hire|seeking|need(?:s|ed)?|hiring|procuro|procuramos|busco|buscamos|preciso|precisamos|contratar|orcamento para|solicitacao de proposta)\b/i;
const employment = /\b(full[- ]time|part[- ]time|estagio|vaga clt|vaga efetiva|emprego|permanent|salary|salario|w2)\b/i;
const contract = /\b(freelanc\w*|contract(?:or)?|projeto fechado|pj)\b/i;
const ignored = /\b(essay writing|data entry only|voiceover only|graphic design only|vulnerability exploit|ddos attack|phishing kit|ransomware|credential stealer|malware development)\b/i;

export function normalize(value = '') {
  return String(value).normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

export function plain(value = '', max = 750) {
  return String(value ?? '').slice(0, 12_000)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|quot|apos|gt|lt|nbsp|#\d{1,7}|#x[\da-f]{1,6});/gi, (entity, name) => {
      const named = { amp: '&', quot: '"', apos: "'", gt: '>', lt: '<', nbsp: ' ' };
      if (name[0] !== '#') return named[name.toLowerCase()];
      const hexadecimal = name[1].toLowerCase() === 'x';
      const code = parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    })
    .replace(/[\s\u0000-\u001f]+/g, ' ').trim().slice(0, max);
}

export function canonicalUrl(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  try {
    const url = new URL(input.trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid$|gclid$|msclkid$)/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.href;
  } catch {
    return null;
  }
}

export function signalCategories(text) {
  return categories.filter(category => signals[category].test(normalize(text)));
}

export function asksForProject(text) {
  const normalized = normalize(text);
  return intent.test(normalized) && (!employment.test(normalized) || contract.test(normalized));
}

export function toOpportunity(raw, now = new Date()) {
  const title = plain(raw.title, 180);
  const description = plain(raw.description);
  const url = canonicalUrl(raw.url);
  if (!title || !url || !kinds.includes(raw.kind)) return null;

  const text = normalize([title, description, ...(raw.skills ?? [])].join(' '));
  if (!raw.manual && ignored.test(text)) return null;
  const detected = signalCategories(text);
  const selected = (raw.categories ?? []).filter(category => categories.includes(category));
  const matched = [...new Set([...selected, ...detected])];
  if (matched.length === 0) return null;

  const date = raw.publishedAt ? new Date(raw.publishedAt) : null;
  const publishedAt = date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
  const age = publishedAt ? Math.max(0, (now - date) / 3_600_000) : Infinity;
  const budget = [raw.budget?.min, raw.budget?.max].filter(n => Number.isFinite(n) && n > 0);
  const marketScore = 45 + (signalCategories(title).length ? 18 : 0) +
    (budget.length ? 10 : 0) + (intent.test(text) || raw.explicit ? 12 : 0) +
    (age < 24 ? 12 : age < 72 ? 7 : 0);
  const score = raw.kind === 'prospeccao' ? (raw.manual ? 45 : 35) : marketScore;

  return {
    id: createHash('sha256').update(url).digest('hex').slice(0, 24),
    title, description, url, publishedAt, score, categories: matched,
    kind: raw.kind, source: plain(raw.source, 60) || 'Importado',
    evidence: plain(raw.evidence, 250),
    organization: plain(raw.organization, 140),
    language: plain(raw.language, 15),
    budget: budget.length ? {
      min: Math.min(...budget), max: Math.max(...budget),
      currency: /^[A-Z]{3}$/.test(raw.budget.currency) ? raw.budget.currency : '',
      hourly: Boolean(raw.budget.hourly),
    } : null,
  };
}
