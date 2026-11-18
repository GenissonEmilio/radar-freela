# Radar Freela

Painel local para descobrir projetos de desenvolvimento e possíveis clientes. Reúne demandas web, mobile, desktop e de integração, registra o andamento comercial e prepara rascunhos editáveis.

## Rodar

Instale Node.js 24 ou superior. No Windows, abra `Iniciar.cmd`. No terminal, rode:

```sh
npm start
```

Acesse [127.0.0.1:4173](http://127.0.0.1:4173). O Radar consulta as fontes habilitadas ao iniciar quando a busca estiver vencida e, por padrão, a cada 30 minutos enquanto o processo estiver ativo. **Buscar agora** inicia uma coleta manual. O painel mostra o resultado de cada fonte em **Fontes**.

O projeto roda sem instalar pacotes. Os registros e as anotações ficam em `data/radar.sqlite` na máquina que executa o serviço. O servidor escuta em loopback para uso local. Para deixar rodando no Windows, use o Agendador de Tarefas com `Iniciar.cmd` ao entrar na sessão. Os avisos do navegador precisam ser habilitados em **Fontes** e dependem da aba aberta e da permissão do navegador.

## Cobertura

| Fonte | O que entra no radar | Configuração |
| --- | --- | --- |
| [Freelancer.com](https://github.com/freelancer/freelancer-sdk-python) | Projetos abertos consultados pela API pública com grupos de habilidades para web, mobile, desktop e integrações. | Ativada inicialmente. |
| [Hacker News / Algolia](https://hn.algolia.com/api) | Publicações recentes com indícios de pedido de desenvolvimento. | Ativada inicialmente. |
| [Brave Search](https://api-dashboard.search.brave.com/documentation/services/web-search) | Resultados públicos recentes em português e inglês de buscas por pedidos de desenvolvimento. | Configure `BRAVE_API_KEY` em `.env`, reinicie e habilite em **Fontes**. Consulte as regras de retenção do seu plano antes de ativar, pois o Radar salva títulos, descrições resumidas e links. |
| [OpenStreetMap / Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API) | Clínicas, comércio, alimentação ou serviços sem site registrado no mapa, dentro de uma área escolhida. São contatos potenciais, e o cadastro por si só não comprova oportunidade ou ausência de site. | Escolha segmento e coordenadas em **Fontes**. |
| [CNES / Ministério da Saúde](https://dadosabertos.saude.gov.br/dataset/cnes-cadastro-nacional-de-estabelecimentos-de-saude) | Clínicas e centros de especialidades de natureza empresarial. Use o cadastro para identificar possíveis clientes e confirmar a necessidade em seguida. | Habilite **Clínicas privadas** e informe o código IBGE do município. |
| Workana, Upwork, 99Freelas, indicações e outras fontes | Registros adicionados por link ou por importação JSON. | Use **Adicionar** ou **Importar JSON**. |

As buscas consultam amostras recentes por fonte. A cobertura depende dos termos, das janelas, da área escolhida e dos limites das APIs. A abertura de um anúncio pode mudar após a coleta. Confira a publicação original antes de investir tempo no orçamento.

Na prospecção local, informe a caixa delimitadora na ordem **sul, oeste, norte, leste**. Por exemplo, `-10.95,-37.10,-10.90,-37.04` define uma área de Aracaju. Para obter limites de outra região, use a [área de exportação do OpenStreetMap](https://www.openstreetmap.org/export). Dados de prospecção local © [colaboradores do OpenStreetMap](https://www.openstreetmap.org/copyright).

A disponibilidade do OpenStreetMap depende da instância Overpass. Se você opera uma instância própria ou tem acesso a um provedor, configure `OVERPASS_URL` em `.env` e reinicie. Use o CNES para a lista de clínicas enquanto o mapa estiver indisponível.

O painel mantém histórico por URL normalizada e preserva etapa e notas quando um link reaparece. A pontuação utiliza aderência temática, idade do anúncio, orçamento informado e sinais de contratação. Prospecções recebem prioridade inicial menor. Use as etapas para refletir o avanço real: novo, em avaliação, proposta enviada, em negociação, fechado ou descartado. A equipe revisa e envia as propostas na plataforma ou no canal original.

## Importar oportunidades

Para alertas recebidos por e-mail, adicione o link do anúncio ou consolide os registros em JSON. O exemplo abaixo é fictício. O lote aceita até 150 registros e 256 KB.

```json
[
  {
    "title": "Aplicativo para agendar serviços",
    "url": "https://example.com/projetos/agenda",
    "kind": "freela",
    "categories": ["Mobile", "Integrações"],
    "source": "Workana",
    "description": "Solicitação de agenda e notificações.",
    "language": "pt-br",
    "budget": { "min": 4000, "max": 8000, "currency": "BRL" }
  },
  {
    "title": "Clínica Exemplo",
    "url": "https://example.com/clinica",
    "kind": "prospeccao",
    "categories": ["Web"],
    "organization": "Clínica Exemplo",
    "description": "Indicação recebida pela equipe."
  }
]
```

Tipos aceitos: `freela` e `prospeccao`. Categorias aceitas: `Web`, `Mobile`, `Desktop` e `Integrações`. Campos obrigatórios: `title`, `url`, `kind` e `categories`. Para integrar uma fonte autorizada na mesma máquina, envie os mesmos dados em um POST JSON para `http://127.0.0.1:4173/api/opportunities`.

## Configuração e verificação

Copie `.env.example` para `.env` quando precisar mudar a porta, o intervalo ou ativar Brave Search. Use `RADAR_INTERVAL_MINUTES=0` para buscar só sob demanda. Para mudar a localização do banco, configure `RADAR_DATA_DIR`. Execute `npm test` para testar classificação, deduplicação, persistência e API local.
