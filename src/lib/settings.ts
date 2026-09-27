import "server-only";
import { cache } from "react";
import { all, run } from "./db";
import { esc, sanitizeContractHtml, type MarcaConfiavel } from "./contract-html";

export type Settings = Record<string, string>;

export const DEFAULT_CONTRACT = `TERMO DE RESPONSABILIDADE E CONTRATO DE LOCACAO

LOCADORA: {{empresa}}, CNPJ {{cnpj}}, com endereco em {{endereco_empresa}}, telefone {{telefone_empresa}}.
LOCATARIO(A): {{cliente}}, CPF/CNPJ {{cliente_doc}}, telefone {{cliente_telefone}}, residente em {{cliente_endereco}}.

CONTRATO N. {{contrato}} - RESERVA {{reserva}}

1. OBJETO
A LOCADORA cede em locacao ao LOCATARIO os equipamentos relacionados abaixo, para uso no evento do dia {{data_evento}}, no endereco {{endereco_evento}}.

{{itens}}

2. PRAZO
Entrega prevista para {{data_entrega}} e retirada prevista para {{data_retirada}}. A permanencia dos equipamentos alem do prazo acordado, sem autorizacao previa, implica cobranca de nova diaria.

3. VALORES
Locacao dos itens: {{valor_itens}}
Frete: {{valor_frete}}
Montagem: {{valor_montagem}}
Desmontagem: {{valor_desmontagem}}
Outros servicos: {{valor_outros}}
Desconto: {{valor_desconto}}
TOTAL: {{valor_total}}
Caucao: {{valor_caucao}}

4. CAUCAO
A caucao e distinta do valor da locacao e sera devolvida integralmente em ate 5 dias uteis apos a retirada, desde que os equipamentos sejam devolvidos na mesma quantidade e estado em que foram entregues. Havendo avaria, falta ou sujeira excessiva, o valor correspondente sera retido, com discriminacao por escrito.

5. RESPONSABILIDADE
O LOCATARIO responde pela guarda e conservacao dos equipamentos desde a entrega ate a retirada, incluindo furto, extravio, quebra e danos causados por terceiros presentes no evento. Os equipamentos nao podem ser sublocados, transportados para outro endereco ou utilizados de forma diversa da sua finalidade.

6. AVARIAS E REPOSICAO
Itens danificados ou nao devolvidos serao cobrados pelo valor de reposicao vigente na tabela da LOCADORA.

7. CANCELAMENTO
O cancelamento com menos de 48 horas de antecedencia nao gera direito a devolucao do sinal pago.

8. FORO
Fica eleito o foro da comarca de {{cidade_empresa}} para dirimir eventuais duvidas oriundas deste contrato.

{{cidade_empresa}}, {{data_hoje}}.


_______________________________          _______________________________
{{empresa}}                               {{cliente}}
LOCADORA                                  LOCATARIO`;

export const DEFAULT_SETTINGS: Settings = {
  stock_preparation_minutes: "0",
  company_name: "Lima's Locacoes",
  company_tagline: "Gestao de Locacoes e Eventos",
  company_doc: "",
  company_phone: "",
  company_whatsapp: "",
  company_email: "",
  company_address: "",
  company_city: "",
  company_logo: "",
  pix_key: "",
  bank_info: "",
  contract_template: DEFAULT_CONTRACT,
  /*
   * Modelo do contrato DIGITAL, usado apenas no fluxo de assinatura online
   * (link /assinar/[token]). Nasce com o mesmo conteúdo do modelo de impressão,
   * preservando o que já estava configurado: a partir daqui os dois modelos são
   * editados e salvos de forma independente. Fica na tabela settings, KV como
   * os demais ajustes — nenhuma migration nova é necessária.
   */
  contract_template_digital: DEFAULT_CONTRACT,
  default_deposit_cents: "0",

  /*
   * Tamanho do recibo: vive na tabela settings (KV), como os demais ajustes.
   * O padrão A4 preserva o comportamento das instalações existentes; a
   * escolha fica em Configurações → Recibos e vale para todos os tipos de
   * recibo (pagamento, adiantamento, caução e quitação). Medidas em mm são
   * usadas pelo CSS (@page size e folha), então o tamanho configurado é o
   * que sai no papel.
   */
  recibo_tamanho: "a4",
  recibo_largura_mm: "105",
  recibo_altura_mm: "148",

  /*
   * Calculadora de frete. Ficam aqui, na tabela settings, em vez de numa tabela
   * nova: sao parametros unicos da empresa, o mesmo formato dos demais ajustes.
   */
  freight_fuel_type: "Etanol",
  freight_fuel_price_cents: "332",
  freight_consumption: "10",
  freight_cost_per_km_cents: "50",
  freight_margin_percent: "30",
  freight_minimum_cents: "3000",
  freight_rounding_cents: "500",
  freight_labor_cents: "0",
  wa_confirm:
    "Ola, {{cliente}}! Sua locacao na {{empresa}} esta confirmada para o dia {{data_evento}}. Reserva {{reserva}}. Qualquer duvida e so chamar!",
  wa_delivery:
    "Ola, {{cliente}}! Passando para confirmar nossa entrega hoje as {{hora_entrega}} no endereco {{endereco_evento}}.",
  wa_pickup:
    "Ola, {{cliente}}! Nossa equipe fara a retirada dos equipamentos hoje as {{hora_retirada}}. Pedimos que os itens estejam reunidos no local.",
  wa_payment:
    "Ola, {{cliente}}! Identificamos um saldo de {{saldo}} referente a sua locacao {{reserva}}. Pix: {{pix}}",
  wa_quote:
    "Ola, {{cliente}}! Segue o orcamento {{orcamento}} da {{empresa}} para o dia {{data_evento}}:\n{{itens}}\nTotal: {{valor_total}}",
};

/**
 * Deduplicacao por requisicao (React cache).
 *
 * Uma tela consulta as settings 2 a 3 vezes (layout pega logo/nome, a pagina
 * pega regras de estoque, modelos, etc). Sem cache, cada getSettings() era uma
 * ida e volta ao D1 — no Workers isso e latencia de rede de verdade. Com o
 * cache do React, a primeira chamada busca uma vez e as demais da MESMA
 * requisicao reutilizam o resultado: zero risco de dado velho entre telas,
 * porque o escopo morre junto com a request. Escritas (setSettings) continuam
 * gravando no banco na hora; a releitura fresca acontece na proxima request.
 */
export const getSettings = cache(async function (): Promise<Settings> {
  const rows = await all<{ key: string; value: string }>("SELECT key, value FROM settings");
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.value !== null && r.value !== undefined) out[r.key] = r.value;
  /**
   * O modelo digital herda o modelo de impressao enquanto nao existir um
   * salvo de forma independente. Bancos antigos, que so tem contract_template,
   * continuam gerando o contrato digital com o texto que ja usavam — sem
   * escrever nada no banco. Salvar o modelo digital na tela de configuracoes
   * persiste a chave e encerra a heranca.
   */
  if (!rows.some((r) => r.key === "contract_template_digital")) {
    out.contract_template_digital = out.contract_template;
  }
  return out;
});

export async function getSetting(key: string): Promise<string> {
  return (await getSettings())[key] ?? "";
}

export async function setSettings(values: Settings) {
  for (const [key, value] of Object.entries(values)) {
    await run("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      key,
      value ?? "",
    ]);
  }
}

/** Substitui {{chave}} pelos valores fornecidos. */
/**
 * Largura da linha de preenchimento manual, por variavel.
 *
 * Serve tambem de lista explicita: so as variaveis daqui viram linha quando
 * nao ha dado cadastrado. Qualquer outra continua com o comportamento antigo,
 * para nao transformar em linha algo calculado, como itens ou totais.
 */
const LARGURA_LINHA: Record<string, number> = {
  cnpj: 32,
  cliente_doc: 32,
  cliente_rg: 28,
  cliente: 46,
  empresa: 46,
  cliente_telefone: 22,
  telefone_empresa: 22,
  cliente_email: 34,
  cliente_cep: 14,
  cliente_endereco: 58,
  endereco_empresa: 58,
  endereco_evento: 58,
  cidade_empresa: 30,
  cliente_cidade: 30,
  cliente_bairro: 30,
  cliente_numero: 12,
};

/** Ha dado utilizavel? Nulo, ausente, vazio ou so espacos contam como vazio. */
function temValor(v: string | number | null | undefined): boolean {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

export type EstrategiaVazio = "vazio" | "linha";

/**
 * Substitui {{variavel}} pelos valores informados.
 *
 * Com a estrategia "linha", uma variavel conhecida e sem dado cadastrado vira
 * um espaco sublinhado para preencher a mao no documento impresso, em vez de
 * sair em branco ou como "-". Isso vale so na renderizacao: o modelo salvo em
 * configuracoes continua guardando {{variavel}} e pode ser reaproveitado.
 *
 * A estrategia padrao continua sendo "vazio", que e o comportamento usado
 * pelas mensagens de WhatsApp, onde uma linha de underscores nao faria sentido.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number | null | undefined>,
  opts: { vazio?: EstrategiaVazio } = {},
) {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k) => {
    const v = vars[k];
    if (temValor(v)) return String(v);
    if (opts.vazio === "linha" && k in LARGURA_LINHA) return "_".repeat(LARGURA_LINHA[k]);
    return "";
  });
}

/**
 * Versao para modelos em HTML (formatacao rica).
 *
 * Reaproveita integralmente o renderTemplate: a substituicao das variaveis e
 * a mesma de sempre. A unica diferenca e que o valor de cada variavel entra
 * escapado — os dados vêm do cadastro e nao podem conter marcacao — e o
 * resultado passa pelo sanitizador, que remove qualquer coisa fora da lista
 * branca do contrato. O modelo antigo em texto puro nunca chega aqui.
 *
 * Variaveis cujo valor ja vem com marcacao propria do sistema ({{itens}},
 * montada por itensParaHtml) entram empacotadas em marcaConfiavel: escapam o
 * conteudo, mas preservam as <li> que o proprio sistema montou.
 */
export function renderTemplateHtml(
  template: string,
  vars: Record<string, string | number | null | undefined | MarcaConfiavel>,
  opts: { vazio?: EstrategiaVazio } = {},
) {
  const seguro: Record<string, string | number | null | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (v !== null && v !== undefined && typeof v === "object" && "marca" in v) {
      seguro[k] = v.marca;
    } else if (temValor(v)) {
      seguro[k] = esc(String(v));
    } else {
      seguro[k] = v;
    }
  }
  return sanitizeContractHtml(renderTemplate(template, seguro, opts));
}
