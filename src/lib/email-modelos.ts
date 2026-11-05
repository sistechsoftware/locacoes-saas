/**
 * Modelos de e-mail personalizáveis por empresa — camada PURA.
 *
 * ONDE MORA: `company_settings`, na chave `email_modelo_<tipo>`, com o JSON dos
 * campos. É o MESMO KV multi-tenant de todas as configurações da empresa
 * (migration 0027): nenhuma tabela nova, nenhuma migration e o isolamento que já
 * existe (toda leitura passa por settingsDaEmpresa(company_id)).
 *
 * POR QUE JSON NUMA CHAVE: cada modelo tem seis campos. Uma chave por campo
 * seriam 90 chaves `email_modelo_*_assunto` na whitelist — ruído no KV e risco
 * de estado meio-salvo. Um JSON por tipo é atômico na prática, versionável e
 * ausente quando a empresa nunca personalizou (aí vale o texto original).
 *
 * REGRA CENTRAL: modelo VAZIO = texto original revisado. Personalizar é opção,
 * nunca obrigação — inclusive porque o padrão é reescrito a cada melhoria.
 */

import { TIPOS_EMAIL, type TipoEmail } from "./email-notificacoes";

/* ------------------------------------------------------------------ */
/* Campos                                                              */
/* ------------------------------------------------------------------ */

export type DefinicaoCampo = {
  chave: CampoModelo;
  rotulo: string;
  descricao: string;
  exemplo: string;
  /** limite em caracteres (validado na action e no parser) */
  max: number;
  multilinha: boolean;
};

export type CampoModelo = "assunto" | "titulo" | "abertura" | "corpo" | "complemento" | "assinatura";

export const CAMPOS_MODELO: DefinicaoCampo[] = [
  {
    chave: "assunto",
    rotulo: "Assunto do e-mail",
    descricao: "Linha que aparece na caixa de entrada. Curta e específica funciona melhor.",
    exemplo: "Sua reserva {{reserva_codigo}} está confirmada",
    max: 160,
    multilinha: false,
  },
  {
    chave: "titulo",
    rotulo: "Título principal",
    descricao: "Primeira linha em destaque dentro do e-mail.",
    exemplo: "Reserva confirmada, {{cliente_nome}}!",
    max: 140,
    multilinha: false,
  },
  {
    chave: "abertura",
    rotulo: "Texto de apresentação",
    descricao: "Um ou dois períodos que explicam por que o cliente está recebendo o e-mail.",
    exemplo: "A {{empresa_nome}} confirmou a sua locação para {{reserva_data_evento}}.",
    max: 600,
    multilinha: true,
  },
  {
    chave: "corpo",
    rotulo: "Corpo da mensagem",
    descricao: "Mensagem principal. Linha em branco separa parágrafos.",
    exemplo: "Confira os detalhes abaixo e avise se algo precisar de ajuste.",
    max: 4000,
    multilinha: true,
  },
  {
    chave: "complemento",
    rotulo: "Texto complementar",
    descricao: "Informação adicional, opcional (instruções, prazos, lembretes).",
    exemplo: "Deixe os itens reunidos no local combinado para agilizar a entrega.",
    max: 900,
    multilinha: true,
  },
  {
    chave: "assinatura",
    rotulo: "Assinatura / encerramento",
    descricao: "Despedida antes do rodapé. Deixe em branco para não exibir.",
    exemplo: "Qualquer dúvida, estamos à disposição.\nEquipe {{empresa_nome}}",
    max: 400,
    multilinha: true,
  },
];

export type ModeloEmail = Partial<Record<CampoModelo, string>>;

const CAMPOS = CAMPOS_MODELO.map((c) => c.chave);
const LIMITE: Record<CampoModelo, number> = CAMPOS_MODELO.reduce(
  (acc, c) => ({ ...acc, [c.chave]: c.max }),
  {} as Record<CampoModelo, number>,
);

/* ------------------------------------------------------------------ */
/* Chaves em company_settings                                          */
/* ------------------------------------------------------------------ */

/** Chave da configuração deste tipo (`email_modelo_reserva_confirmacao`). */
export function chaveModelo(tipo: TipoEmail): string {
  return `email_modelo_${tipo}`;
}

/** Todas as chaves que a whitelist de settings precisa conhecer. */
export function chavesModeloEmail(): string[] {
  return (Object.keys(TIPOS_EMAIL) as TipoEmail[]).map(chaveModelo);
}

/* ------------------------------------------------------------------ */
/* Normalização e validação                                            */
/* ------------------------------------------------------------------ */

/** ASCII de controle vira espaço; quebra de linha é conteúdo legítimo. */
function limparTexto(valor: unknown): string {
  return String(valor ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ")
    .trim();
}

/**
 * Converte JSON (ou objeto) em modelo válido. Campo desconhecido é descartado;
 * campo acima do limite é cortado aqui (a action recusa antes, com mensagem).
 */
export function normalizarModelo(bruto: unknown): ModeloEmail {
  const obj = typeof bruto === "string" ? safeJson(bruto) : bruto;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  const out: ModeloEmail = {};
  for (const campo of CAMPOS) {
    const valor = limparTexto((obj as Record<string, unknown>)[campo]);
    if (valor) out[campo] = valor.slice(0, LIMITE[campo]);
  }
  return out;
}

function safeJson(texto: string): unknown {
  try {
    return JSON.parse(texto);
  } catch {
    return null;
  }
}

/** Modelo lido da chave da empresa; null quando não personalizado/ilegível. */
export function lerModelo(settings: Record<string, string>, tipo: TipoEmail): ModeloEmail | null {
  const bruto = settings?.[chaveModelo(tipo)];
  if (!bruto) return null;
  const modelo = normalizarModelo(bruto);
  return modeloTemConteudo(modelo) ? modelo : null;
}

/** Todos os modelos da empresa, para a tela (sem consultar o banco de novo). */
export function lerModelos(settings: Record<string, string>): Record<TipoEmail, ModeloEmail> {
  const out = {} as Record<TipoEmail, ModeloEmail>;
  for (const tipo of Object.keys(TIPOS_EMAIL) as TipoEmail[]) out[tipo] = lerModelo(settings, tipo) ?? {};
  return out;
}

export function modeloVazio(m: ModeloEmail | null | undefined): boolean {
  return !m || CAMPOS.every((c) => !String(m[c] ?? "").trim());
}

export const modeloPersonalizado = (m: ModeloEmail | null | undefined): boolean => !modeloVazio(m);

export function modeloTemConteudo(m: ModeloEmail | null | undefined): boolean {
  return !modeloVazio(m);
}

/** JSON para gravar; modelo vazio vira string vazia (volta ao original). */
export function serializarModelo(m: ModeloEmail | null | undefined): string {
  const limpo = normalizarModelo(m ?? {});
  return modeloVazio(limpo) ? "" : JSON.stringify(limpo);
}

/** Erro de validação para a tela, ou null quando tudo cabe nos limites. */
export function validarModelo(bruto: unknown): string | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return "Modelo inválido.";
  for (const campo of CAMPOS_MODELO) {
    if (!(campo.chave in (bruto as Record<string, unknown>))) continue;
    const valor = (bruto as Record<string, unknown>)[campo.chave];
    if (typeof valor !== "string") return `${campo.rotulo}: valor inválido.`;
    // Conta o texto sem normalizar: o limite vale para o que a pessoa digitou.
    if (valor.replace(/\r\n?/g, "\n").trim().length > campo.max) {
      return `${campo.rotulo}: use no máximo ${campo.max} caracteres.`;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Texto de apoio da tela                                              */
/* ------------------------------------------------------------------ */

/** Resumo curto do modelo, para a lista de tipos na tela. */
export function resumoModelo(m: ModeloEmail | null | undefined): string {
  if (modeloVazio(m)) return "Usando o texto original";
  const campos = CAMPOS_MODELO.filter((c) => String(m?.[c.chave] ?? "").trim()).length;
  return `${campos} ${campos === 1 ? "campo personalizado" : "campos personalizados"}`;
}
