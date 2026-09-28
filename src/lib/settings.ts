import "server-only";
import { cache } from "react";
import { all, run } from "./db";
import { tenantCompanyId } from "./tenant";
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
A caucao e distinta do valor da locacao e sera devolvida integralmente em ate 5 dias uteis após a retirada, desde que os equipamentos sejam devolvidos na mesma quantidade e estado em que foram entregues. Havendo avaria, falta ou sujeira excessiva, o valor correspondente sera retido, com discriminacao por escrito.

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

/**
 * Padrões da plataforma. Específicos da empresa (nome, logo, PIX, templates,
 * mensagens) saem de company_settings; o que sobra aqui é default técnico
 * neutro, sem marca.
 */
export const DEFAULT_SETTINGS: Settings = {
  stock_preparation_minutes: "0",
  company_name: "",
  company_tagline: "Gestao de Locacoes e Eventos",
  company_doc: "",
  company_phone: "",
  company_whatsapp: "",
  company_email: "contato@exemplo.com.br",
  company_address: "",
  company_city: "",
  company_logo: "",
  pix_key: "",
  bank_info: "",
  contract_template: DEFAULT_CONTRACT,
  contract_template_digital: DEFAULT_CONTRACT,
  default_deposit_cents: "0",
  recibo_tamanho: "a4",
  recibo_largura_mm: "105",
  recibo_altura_mm: "148",
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
  /* Chaves dos modulos de fidelidade e aniversarios. Vazias, o comportamento
   * e o padrao historico (modulo ligado, mensagem modelo, hora 08). Entram
   * aqui para a whitelist de setSettings aceita-las por empresa. */
  fidelity_active: "",
  fidelity_goal: "",
  fidelity_kits: "",
  fidelity_validity_days: "",
  fidelity_accumulate: "",
  fidelity_count_free_rental: "",
  fidelity_return_on_cancel: "",
  fidelity_min_value_cents: "",
  fidelity_eligible_status: "",
  fidelity_expiry_reminders: "",
  fidelity_window_start: "",
  fidelity_window_end: "",
  fidelity_notify_progress: "",
  fidelity_notify_almost: "",
  fidelity_notify_earned: "",
  fidelity_notify_used: "",
  fidelity_notify_expiring: "",
  fidelity_notify_expired: "",
  fidelity_msg_progress: "",
  fidelity_msg_quase_la: "",
  fidelity_msg_conquista: "",
  fidelity_msg_uso: "",
  fidelity_msg_vencendo: "",
  fidelity_msg_expirada: "",
  birthday_active: "",
  birthday_days_ahead: "",
  birthday_notify_today: "",
  birthday_notify_upcoming: "",
  birthday_push: "",
  birthday_hour: "",
};

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

/**
 * Configurações da empresa autenticada.
 *
 * A fonte é `company_settings` (migration 0027) escopada pelo company_id da
 * sessão — nunca da requisição. Cada empresa possui seus próprios textos,
 * templates, PIX e preferências; os defaults técnicos vêm daqui.
 */
export const getSettings = cache(async function (): Promise<Settings> {
  const companyId = await tenantCompanyId();
  const out: Settings = { ...DEFAULT_SETTINGS };
  const rows = await all<{ key: string; value: string | null }>(
    "SELECT key, value FROM company_settings WHERE company_id = ?",
    [companyId],
  );
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

/** Chaves de configuração reconhecidas (protege contra lixo via request). */
export function isKnownSetting(key: string): boolean {
  return SETTING_KEYS.includes(key);
}

/**
 * Grava configurações da empresa informada — sempre a do contexto autenticado
 * em telas; o parâmetro existe para seed/cron/onboarding.
 */
export async function setSettings(values: Settings, companyId?: number) {
  const cid = companyId ?? (await tenantCompanyId());
  for (const [key, value] of Object.entries(values)) {
    if (!isKnownSetting(key)) continue;
    await run(
      `INSERT INTO company_settings (company_id, key, value) VALUES (?,?,?)
         ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`,
      [cid, key, value ?? ""],
    );
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
