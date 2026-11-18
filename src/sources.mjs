import { asksForProject, plain, signalCategories } from './opportunities.mjs';

const day = 86_400_000;
export const defaults = {
  marketplace: true,
  community: true,
  web: false,
  local: false,
  clinics: false,
  city: '',
  bounds: '',
  municipality: '',
  segment: 'clinicas',
};

const segments = {
  clinicas: ['Clínicas e consultórios', 'amenity~"^(clinic|dentist|doctors)$"'],
  comercio: ['Comércio', 'shop~"^(clothes|convenience|hardware|florist|furniture|gift|books)$"'],
  restaurantes: ['Alimentação', 'amenity~"^(restaurant|cafe|fast_food)$"'],
  servicos: ['Serviços', 'office~"^(accountant|estate_agent|lawyer|insurance|company)$"'],
};

export function validateSettings(input, hasWebKey) {
  const settings = { ...defaults };
  for (const name of ['marketplace', 'community', 'web', 'local', 'clinics']) {
    if (typeof input?.[name] === 'boolean') settings[name] = input[name];
  }
  settings.city = plain(input?.city, 100);
  settings.bounds = plain(input?.bounds, 120);
  settings.municipality = plain(input?.municipality, 20).replace(/^(\d{6})-?\d$/, '$1');
  settings.segment = Object.hasOwn(segments, input?.segment) ? input.segment : defaults.segment;
  if (settings.web && !hasWebKey) throw new Error('Configure BRAVE_API_KEY no arquivo .env para ativar a busca na web.');
  if (settings.local) coordinates(settings.bounds);
  if (settings.clinics && !/^\d{6}$/.test(settings.municipality)) {
    throw new Error('Informe o código IBGE do município com 6 ou 7 dígitos.');
  }
  return settings;
}

function coordinates(value) {
  const parts = value.split(',').map(part => part.trim());
  const [south, west, north, east] = parts.map(Number);
  if (parts.length !== 4 || parts.some(part => !/^-?\d+(\.\d+)?$/.test(part)) ||
    south < -90 || north > 90 || west < -180 || east > 180 ||
    north <= south || east <= west || north - south > 1 || east - west > 1) {
    throw new Error('Informe sul, oeste, norte e leste, em graus decimais, com no máximo 1° por lado.');
  }
  return [south, west, north, east].join(',');
}

async function getJson(endpoint, { params, headers, timeout = 15_000, body } = {}) {
  const url = new URL(endpoint);
  for (const [key, value] of params ?? []) url.searchParams.append(key, value);
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'RadarFreela/1.0 (+https://github.com/GenissonEmilio/radar-freela)', ...headers },
    signal: AbortSignal.timeout(timeout),
    method: body ? 'POST' : 'GET',
    body,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

// Keep successful queries if another query hits a quota or is unavailable.
async function collect(queries, fetchOne) {
  const items = [];
  const errors = [];
  for (const query of queries) {
    try {
      items.push(...await fetchOne(query));
    } catch (error) {
      errors.push(error.message);
      if (error.message === 'HTTP 429') break;
    }
  }
  if (errors.length === queries.length || (errors.length && items.length === 0)) {
    throw new Error(errors[0]);
  }
  return { items, warning: errors.length ? `Coleta parcial (${errors[0]})` : '' };
}

function marketplace() {
  const groups = [
    [17, 1031, 3, 1088], // Web
    [44, 58, 59, 1314, 1315], // Mobile
    [29, 1917, 2407, 3180], // Desktop
    [116, 2165], // Software Architecture, API Integration
  ];

  return collect(groups, async skills => {
    const result = await getJson('https://www.freelancer.com/api/projects/0.1/projects/active/', {
      params: [
        ['limit', '50'], ['job_details', 'true'], ['compact', 'true'],
        ['from_time', Math.floor((Date.now() - 7 * day) / 1000)],
        ...skills.map(id => ['jobs[]', id]),
      ],
    });
    if (result.status !== 'success' || !Array.isArray(result.result?.projects)) {
      throw new Error('Resposta inesperada da API');
    }
    return result.result.projects
      .filter(item => item.status === 'active' && item.frontend_project_status === 'open' &&
        !item.deleted && !item.nonpublic && !item.hireme && !item.upgrades?.fulltime && item.seo_url)
      .map(item => ({
        kind: 'freela', source: 'Freelancer.com', title: item.title,
        description: item.preview_description, explicit: true,
        url: `https://www.freelancer.com/projects/${item.seo_url}`,
        skills: item.jobs?.map(job => job.name),
        publishedAt: item.submitdate ? item.submitdate * 1000 : null,
        language: item.language,
        budget: { min: item.budget?.minimum, max: item.budget?.maximum,
          currency: item.currency?.code, hourly: item.type === 'hourly' },
        evidence: 'Projeto aberto na plataforma ao consultar a API.',
      }));
  });
}

function community() {
  return collect(['looking for a freelance developer', 'need a developer', 'looking for a contractor'], async query => {
    const result = await getJson('https://hn.algolia.com/api/v1/search_by_date', {
      params: [['query', query], ['tags', 'story'], ['hitsPerPage', '30'],
        ['numericFilters', `created_at_i>${Math.floor((Date.now() - 30 * day) / 1000)}`]],
    });
    if (!Array.isArray(result.hits)) throw new Error('Resposta inesperada da API');
    return result.hits
      .filter(item => item.title && /^\d+$/.test(item.objectID) &&
        asksForProject(plain(item.title + ' ' + (item.story_text ?? ''))) &&
        !/^(show hn:|ask hn: who is hiring|ask hn: freelancer)/i.test(item.title))
      .map(item => ({
        kind: 'freela', source: 'Hacker News', title: item.title,
        description: item.story_text, publishedAt: item.created_at, language: 'en',
        url: `https://news.ycombinator.com/item?id=${item.objectID}`,
        evidence: 'Pedido identificado em publicação pública. Confirme se ainda está aberto.',
      }));
  });
}

function web(key) {
  const searches = [
    ['"preciso de" "criar um site" freelancer', 'pt-br'],
    ['"procuro desenvolvedor" "aplicativo" projeto', 'pt-br'],
    ['"busco" "sistema desktop" desenvolvimento', 'pt-br'],
    ['"looking for" "freelance developer" "website"', 'en'],
    ['"looking for" "mobile app developer" "freelance"', 'en'],
    ['"looking for" "desktop application" "freelance"', 'en'],
  ];
  return collect(searches, async ([query, language]) => {
    const result = await getJson('https://api.search.brave.com/res/v1/web/search', {
      headers: { 'X-Subscription-Token': key },
      params: [['q', query], ['freshness', 'pm'], ['count', '15'],
        ['country', language === 'en' ? 'US' : 'BR']],
    });
    return (result.web?.results ?? [])
      .filter(item => {
        const text = plain(`${item.title} ${item.description}`);
        return asksForProject(text) && signalCategories(text).length > 0;
      })
      .map(item => ({
        kind: 'freela', source: 'Busca web', title: item.title, description: item.description,
        url: item.url, language,
        evidence: 'Possível pedido em resultado de busca. Valide o anúncio na fonte.',
      }));
  });
}

async function local(settings) {
  const [label, tag] = segments[settings.segment];
  const query = `[out:json][timeout:18];nwr[${tag}]["name"][!"website"][!"contact:website"](${coordinates(settings.bounds)});out tags 60;`;
  const endpoint = process.env.OVERPASS_URL ?? 'https://overpass.private.coffee/api/interpreter';
  const result = await getJson(endpoint, {
    body: new URLSearchParams({ data: query }),
    timeout: 25_000,
  });
  if (!Array.isArray(result.elements) || result.remark) throw new Error('Consulta ao mapa incompleta');
  return {
    items: result.elements.filter(item => ['node', 'way', 'relation'].includes(item.type))
      .map(item => ({
        title: item.tags.name, organization: item.tags.name,
        kind: 'prospeccao', source: 'OpenStreetMap', categories: ['Web'],
        description: [label, settings.city].filter(Boolean).join(' · '),
        url: `https://www.openstreetmap.org/${item.type}/${item.id}`,
        language: 'pt-br',
        evidence: 'O cadastro no mapa não traz um site. Pesquise se já existe um antes de propor uma solução.',
      })),
  };
}

async function clinics(settings) {
  const items = [];
  const endpoint = 'https://apidadosabertos.saude.gov.br/cnes/estabelecimentos';
  for (const offset of [0, 20, 40, 60, 80]) {
    const result = await getJson(endpoint, {
      params: [['codigo_municipio', settings.municipality], ['codigo_tipo_unidade', '36'],
        ['limit', '20'], ['offset', String(offset)]],
    });
    if (!Array.isArray(result.estabelecimentos)) throw new Error('Resposta inesperada da API');
    for (const item of result.estabelecimentos) {
      const cnes = String(item.codigo_cnes);
      const title = item.nome_fantasia;
      const nature = String(item.descricao_natureza_juridica_estabelecimento ?? '').trim();
      if (String(item.codigo_municipio) !== settings.municipality || Number(item.codigo_tipo_unidade) !== 36 ||
        !/^2\d{3}$/.test(nature) || item.codigo_motivo_desabilitacao_estabelecimento ||
        !/^\d{1,7}$/.test(cnes) || !title) continue;
      items.push({
        kind: 'prospeccao', source: 'CNES', categories: ['Web', 'Integrações'], title, organization: title,
        description: 'Clínica ou centro privado de especialidades.',
        url: `${endpoint}/${cnes.padStart(7, '0')}`, language: 'pt-br',
        evidence: 'Estabelecimento listado no cadastro do Ministério da Saúde. A necessidade de desenvolvimento precisa ser confirmada.',
      });
    }
    if (result.estabelecimentos.length < 20 || items.length >= 40) break;
  }
  return { items: items.slice(0, 40) };
}

export function activeSources(settings, key) {
  return [
    ['Freelancer.com', settings.marketplace && marketplace],
    ['Hacker News', settings.community && community],
    ['Busca web', settings.web && key && (() => web(key))],
    ['OpenStreetMap', settings.local && (() => local(settings))],
    ['CNES', settings.clinics && (() => clinics(settings))],
  ].filter(([, run]) => run);
}
