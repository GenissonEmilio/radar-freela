const $ = selector => document.querySelector(selector);
const stages = {
  novo: 'Novo', avaliar: 'Em avaliação', proposta: 'Proposta enviada',
  negociacao: 'Em negociação', fechado: 'Fechado', descartado: 'Descartado',
};
const kindLabel = { freela: 'Freela', prospeccao: 'Prospecção' };
const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
let state;
let kind = '';
let selected = '';
let limit = 35;
let toastTimer;
let lastScan;
let loaded = false;
let detailSignature;
let refreshing = false;
const drafts = new Map();

function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 4300);
}

async function api(path, method = 'GET', body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Não consegui concluir a operação.');
  return data;
}

function dateLabel(date) {
  return dateFormat.format(new Date(date));
}

function normalized(value) {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

function budgetLabel(budget) {
  if (!budget) return 'Orçamento a confirmar';
  const fmt = budget.currency
    ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: budget.currency })
    : new Intl.NumberFormat('pt-BR');
  const formatted = budget.min === budget.max ? fmt.format(budget.min) :
    `${fmt.format(budget.min)} a ${fmt.format(budget.max)}`;
  return formatted + (budget.hourly ? ' / hora' : '');
}

function renderStatus() {
  const scanButton = $('#scan-button');
  scanButton.disabled = state.running;
  scanButton.textContent = state.running ? 'Buscando…' : 'Buscar agora';
  const summary = $('#scan-summary');
  const failed = state.scan?.sources.some(source => source.state !== 'ok');
  summary.dataset.state = failed && !state.running ? 'error' : '';
  const auto = state.interval ? ` · A cada ${state.interval} min` : ' · Busca manual';
  summary.textContent = state.running ? 'Coletando oportunidades…' :
    (state.scan ? `Última busca ${dateLabel(state.scan.at)}${failed ? ' · Ver fontes' : ''}` :
      'Aguardando a primeira busca') + auto;
  const health = state.running ? state.progress : state.scan?.sources ?? [];
  $('#source-health').replaceChildren(...health.map(row => {
    const count = row.state === 'running' ? 'buscando…' : row.state === 'error' ? row.warning :
      `${row.matched} compatíveis, ${row.created} novos${row.warning ? ' · ' + row.warning : ''}`;
    return el('p', `${row.source} · ${count}`);
  }));
}

function renderStats(records) {
  const open = record => !['fechado', 'descartado'].includes(record.stage);
  $('#stat-new').textContent = records.filter(record => record.stage === 'novo').length;
  $('#stat-freela').textContent = records.filter(record => record.kind === 'freela' && open(record)).length;
  $('#stat-prospect').textContent = records.filter(record => record.kind === 'prospeccao' && open(record)).length;
  $('#stat-negotiation').textContent = records.filter(record => record.stage === 'negociacao').length;
}

function matching() {
  const term = normalized($('#search').value.trim());
  const category = $('#category').value;
  const stage = $('#stage').value;
  const source = $('#source').value;
  const sort = $('#sort').value;
  const byDate = (a, b) => (b.publishedAt ?? b.firstSeen).localeCompare(a.publishedAt ?? a.firstSeen);
  return state.opportunities.filter(item =>
    (!kind || item.kind === kind) && (!category || item.categories.includes(category)) &&
    (stage ? item.stage === stage : item.stage !== 'descartado') && (!source || item.source === source) &&
    (!term || normalized([item.title, item.organization, item.description, item.categories.join(' ')]
      .join(' ')).includes(term)),
  ).sort(sort === 'date' ? byDate : (a, b) => b.score - a.score || byDate(a, b));
}

function renderQueue() {
  const items = matching();
  const focusId = document.activeElement?.dataset?.id;
  $('#count').textContent = `${items.length} ${items.length === 1 ? 'oportunidade' : 'oportunidades'}`;
  $('#results').replaceChildren(...items.slice(0, limit).map(item => {
    const button = el('button', undefined, {
      class: 'item', type: 'button', 'aria-current': String(item.id === selected), 'data-id': item.id,
    });
    button.append(el('strong', item.title),
      el('small', [item.source, item.categories.join(' / '), stages[item.stage]].join(' · ')),
      el('span', String(item.score), { class: 'score', title: 'Pontuação de aderência' }));
    const row = el('li');
    row.append(button);
    return row;
  }));
  if (!items.length) $('#results').append(el('li', 'Nenhuma oportunidade para estes filtros.', { class: 'empty' }));
  $('#more').hidden = items.length <= limit;
  if (focusId) document.querySelector(`[data-id="${focusId}"]`)?.focus({ preventScroll: true });
}

function draft(item) {
  if (item.kind === 'prospeccao') {
    const greeting = item.organization ? `Olá, equipe de ${item.organization}!` : 'Olá! Tudo bem?';
    const question = item.source === 'CNES'
      ? 'Vocês têm alguma dificuldade hoje com agendamento, formulários ou integração entre sistemas?'
      : 'Vocês já têm um site ou gostariam de melhorar como os clientes encontram a empresa e entram em contato?';
    return `${greeting}\n\nDesenvolvemos sites e sistemas sob medida. ${question} Se esse assunto estiver nos planos, podemos conversar sobre o que faria diferença para a operação.\n\n[Seu nome]`;
  }
  if (item.language.toLowerCase() === 'en') {
    return `Hi! I saw your project “${item.title}”. Our team works on ${item.categories.join(', ').replace('Integrações', 'integrations')} projects.\n\nDo you have an existing system or design, and which features are essential for the first release? With that information we can suggest a scope and estimate.\n\n[Add a relevant portfolio link]\n[Your name]`;
  }
  return `Olá! Vi seu pedido “${item.title}”. Nossa equipe desenvolve projetos de ${item.categories.join(', ')}.\n\nJá existe um sistema ou design? Quais recursos precisam estar prontos na primeira entrega? Com essas informações podemos sugerir um escopo e preparar um orçamento.\n\n[Inclua um link do portfólio relacionado]\n[Seu nome]`;
}

async function patch(item, changes) {
  try {
    const updated = await api(`/api/opportunities/${item.id}`, 'PATCH', changes);
    if ('notes' in changes) drafts.delete(item.id);
    state.opportunities = state.opportunities.map(record => record.id === item.id ? updated : record);
    render();
    toast('Oportunidade atualizada.');
  } catch (error) {
    toast(error.message);
    detailSignature = null;
    renderDetail();
  }
}

function renderDetail() {
  const item = state.opportunities.find(record => record.id === selected);
  const signature = item ? JSON.stringify(item) : '';
  if (signature === detailSignature) return;
  detailSignature = signature;
  const container = $('#detail');
  if (!item) {
    container.replaceChildren(el('p', 'Selecione uma oportunidade para ver os detalhes.'));
    return;
  }

  const title = el('h2', item.title, { tabindex: '-1' });
  const chips = el('div', undefined, { class: 'chips' });
  for (const category of item.categories) chips.append(el('span', category, { class: 'chip' }));

  const stageLabel = el('label', 'Etapa');
  const stage = el('select');
  for (const [key, label] of Object.entries(stages)) stage.add(new Option(label, key, false, key === item.stage));
  stage.addEventListener('change', () => { stage.disabled = true; void patch(item, { stage: stage.value }); });
  stageLabel.append(stage);

  const notesLabel = el('label', 'Anotações');
  const notes = el('textarea', undefined, { rows: '3', maxlength: '4000', placeholder: 'Escopo, próximo passo…' });
  notes.value = drafts.get(item.id) ?? item.notes;
  notes.addEventListener('input', () => drafts.set(item.id, notes.value));
  notesLabel.append(notes);

  const actions = el('div', undefined, { class: 'detail-actions' });
  const save = el('button', 'Salvar anotações', { type: 'button' });
  save.addEventListener('click', async () => {
    save.disabled = true;
    await patch(item, { notes: notes.value });
    save.disabled = false;
  });
  actions.append(save, el('a', 'Abrir fonte original ↗', { href: item.url, target: '_blank', rel: 'noopener noreferrer' }));

  const details = el('details');
  const proposal = el('textarea', undefined, { 'aria-label': 'Rascunho editável', rows: '8' });
  proposal.value = draft(item);
  const copy = el('button', 'Copiar rascunho', { type: 'button' });
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(proposal.value);
      toast('Rascunho copiado.');
    } catch {
      proposal.select();
      toast('Selecione Copiar no navegador.');
    }
  });
  details.append(el('summary', item.kind === 'freela' ? 'Rascunho de proposta' : 'Rascunho de abordagem'),
    el('p', 'Revise o texto antes de usar.', { class: 'meta' }), proposal, copy);

  const origin = [kindLabel[item.kind], item.source, item.organization].filter(Boolean).join(' · ');
  container.replaceChildren(el('div', origin, { class: 'meta' }), title, chips,
    el('p', item.description || 'Abra o link original para ver o escopo.'),
    el('p', item.evidence, { class: 'evidence' }),
    el('p', [budgetLabel(item.budget), item.publishedAt ? dateLabel(item.publishedAt) : 'Publicação sem data'].join(' · '),
      { class: 'meta' }), stageLabel, notesLabel, actions, details);
}

function render() {
  const source = $('#source');
  const value = source.value;
  const names = [...new Set(state.opportunities.map(item => item.source))].sort();
  if (JSON.stringify(names) !== JSON.stringify([...source.options].slice(1).map(option => option.value))) {
    source.replaceChildren(new Option('Todas as fontes', ''), ...names.map(name => new Option(name, name)));
    if (names.includes(value)) source.value = value;
  }
  renderStatus();
  renderStats(state.opportunities);
  renderQueue();
  renderDetail();
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const data = await api('/api/state');
    const scan = data.scan;
    if (scan?.at && scan.at !== lastScan) {
      const newCount = scan.sources.reduce((sum, row) => sum + (row.created ?? 0), 0);
      if (loaded && newCount > 0 && 'Notification' in window && Notification.permission === 'granted') {
        try { new Notification('Radar Freela', { body: `${newCount} novas oportunidades.`, tag: 'radar-freela' }); }
        catch { /* Some browsers require a service worker for desktop notifications. */ }
      }
      lastScan = scan.at;
    }
    loaded = true;
    if (!state || JSON.stringify(state) !== JSON.stringify(data)) {
      state = data;
      render();
    }
  } catch {
    $('#scan-summary').textContent = 'Painel desconectado. Confira se o Radar Freela está em execução.';
    $('#scan-summary').dataset.state = 'error';
  } finally {
    refreshing = false;
  }
}

for (const [key, label] of Object.entries(stages)) $('#stage').add(new Option(label, key));
for (const selector of ['#search', '#category', '#stage', '#source', '#sort']) {
  $(selector).addEventListener('input', () => { if (state) { limit = 35; renderQueue(); } });
}
for (const tab of document.querySelectorAll('[data-kind]')) {
  tab.addEventListener('click', () => {
    kind = tab.dataset.kind;
    limit = 35;
    document.querySelectorAll('[data-kind]').forEach(button => button.setAttribute('aria-pressed', button === tab));
    if (state) renderQueue();
  });
}
$('#more').addEventListener('click', () => { limit += 35; renderQueue(); });
$('#results').addEventListener('click', event => {
  const button = event.target.closest('[data-id]');
  if (!button) return;
  selected = button.dataset.id;
  renderQueue();
  renderDetail();
  $('#detail h2')?.focus();
});
$('#scan-button').addEventListener('click', async () => {
  $('#scan-button').disabled = true;
  try {
    await api('/api/scan', 'POST', {});
    await refresh();
  } catch (error) { toast(error.message); }
  finally { $('#scan-button').disabled = Boolean(state?.running); }
});

const settingsForm = $('#settings-form');
function showSourceFields() {
  $('#local-fields').hidden = !settingsForm.elements.local.checked;
  $('#clinic-fields').hidden = !settingsForm.elements.clinics.checked;
}
$('#sources-button').addEventListener('click', () => {
  if (!state) return;
  const { settings, hasWebKey } = state;
  for (const [key, value] of Object.entries(settings)) {
    const input = settingsForm.elements.namedItem(key);
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value;
  }
  settingsForm.elements.web.disabled = !hasWebKey;
  $('#web-help').textContent = hasWebKey ? 'Pedidos públicos em português e inglês.' : 'Configure BRAVE_API_KEY no arquivo .env.';
  $('#settings-error').textContent = '';
  showSourceFields();
  $('#sources-dialog').showModal();
});
settingsForm.elements.local.addEventListener('change', showSourceFields);
settingsForm.elements.clinics.addEventListener('change', showSourceFields);
settingsForm.addEventListener('submit', async event => {
  event.preventDefault();
  const fields = settingsForm.elements;
  try {
    state.settings = await api('/api/settings', 'PUT', {
      marketplace: fields.marketplace.checked, community: fields.community.checked,
      web: !fields.web.disabled && fields.web.checked, local: fields.local.checked,
      city: fields.city.value, bounds: fields.bounds.value, segment: fields.segment.value,
      clinics: fields.clinics.checked, municipality: fields.municipality.value,
    });
    $('#sources-dialog').close();
    toast('Fontes salvas. Use Buscar agora para testar.');
  } catch (error) { $('#settings-error').textContent = error.message; }
});
$('#notice-button').addEventListener('click', async () => {
  if (!('Notification' in window)) return toast('Este navegador não oferece notificações.');
  const permission = await Notification.requestPermission();
  toast(permission === 'granted' ? 'Avisos ativados neste navegador.' : 'Avisos não ativados.');
});
for (const close of document.querySelectorAll('[data-close]')) {
  close.addEventListener('click', () => close.closest('dialog').close());
}

$('#add-button').addEventListener('click', () => {
  $('#add-error').textContent = '';
  $('#add-dialog').showModal();
});
$('#add-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type=submit]');
  const item = Object.fromEntries(new FormData(form));
  item.categories = [item.category];
  button.disabled = true;
  try {
    const result = await api('/api/opportunities', 'POST', item);
    form.reset();
    $('#add-dialog').close();
    await refresh();
    toast(result.created ? 'Oportunidade adicionada.' : 'Oportunidade atualizada pelo link.');
  } catch (error) { $('#add-error').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#import').addEventListener('change', async event => {
  const file = event.currentTarget.files[0];
  event.currentTarget.value = '';
  if (!file) return;
  try {
    if (file.size > 256_000) throw new Error('O arquivo deve ter até 256 KB.');
    const items = JSON.parse(await file.text());
    const result = await api('/api/opportunities', 'POST', items);
    await refresh();
    toast(`${result.created} novas de ${result.matched} oportunidades importadas.`);
  } catch (error) { toast(error instanceof SyntaxError ? 'O arquivo não é um JSON válido.' : error.message); }
});

void refresh();
setInterval(() => void refresh(), 5000);
