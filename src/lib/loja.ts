/**
 * Loja Virtual — REGRAS PURAS (sem banco, sem next/*, sem node:*).
 *
 * Este módulo é consumido pelo servidor (actions/rotas), pelas páginas
 * públicas e pela pré-visualização do painel, então precisa rodar nos dois
 * lados. Tudo que toca banco ou sessão vive em loja-db.ts / loja-publico.ts.
 *
 * Decisões fixadas aqui:
 *  * slug público: minúsculas, dígitos e hífens, com lista de reservados —
 *    nada de rota interna pode ser sequestrada como identificador de loja;
 *  * paleta: cores da loja são INDEPENDENTES do painel (temas.ts) e passam
 *    por validação de contraste WCAG antes de serem aceitas;
 *  * dinheiro circula em centavos (inteiro), como no resto do sistema;
 *  * o Pix é BR Code de verdade (payload EMV do Banco Central + CRC16-CCITT)
 *    com o valor do pedido — nunca um "QR de exemplo".
 */
import { contraste } from "./temas";

/* ------------------------------------------------------------------ */
/* Slug público                                                        */
/* ------------------------------------------------------------------ */

export const SLUG_MIN = 3;
export const SLUG_MAX = 40;

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Identificadores que jamais podem virar slug: rotas internas, portas de
 * administração e palavras que mudariam o sentido do endereço. A lista é
 * deliberadamente ampla — um slug reservado bloqueado é incomodidade mínima;
 * um slug que colide com rota é falha de segurança.
 */
export const SLUGS_RESERVADOS: ReadonlySet<string> = new Set([
  "api", "app", "apps", "admin", "administracao", "assets", "static", "public",
  "arquivo", "files", "file", "img", "images", "media", "upload", "uploads",
  "login", "logout", "entrar", "sair", "auth", "oauth", "sessao", "session",
  "portal", "saas", "config", "configuracoes", "settings", "setup", "status",
  "health", "metrics", "docs", "doc", "swagger", "graphql", "webhook",
  "webhooks", "suporte", "support", "chat", "notificacoes", "push",
  "planos", "plan", "assinar", "assinatura", "checkout", "pagamento", "pagar",
  "recuperar-senha", "redefinir-senha", "reset", "nova", "novo", "nova-senha",
  "loja", "store", "shop", "sitemap", "robots", "manifest", "favicon",
  "next", "_next", "www", "mail", "smtp", "cdn", "blog", "rss", "feed",
  "terms", "privacy", "privacidade", "termos", "diagnostico-pwa", "origem",
]);

/** Minúsculas, sem acento, sem caracteres estranhos — formato do endereço. */
export function normalizarSlug(input: string): string {
  return (input ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX);
}

export type ResultadoSlug = { ok: boolean; erro?: string };

/** Valida o slug NO SERVIDOR. Nunca confie no que o navegador mandou. */
export function validarSlug(slug: string): ResultadoSlug {
  const s = (slug ?? "").trim();
  if (s.length < SLUG_MIN) return { ok: false, erro: `O identificador precisa de ao menos ${SLUG_MIN} caracteres.` };
  if (s.length > SLUG_MAX) return { ok: false, erro: `O identificador pode ter no máximo ${SLUG_MAX} caracteres.` };
  if (!SLUG_RE.test(s)) {
    return { ok: false, erro: "Use apenas letras minúsculas, números e hífens (sem espaços nem acentos)." };
  }
  if (SLUGS_RESERVADOS.has(s)) return { ok: false, erro: "Este identificador é reservado. Escolha outro." };
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Paletas da loja                                                     */
/* ------------------------------------------------------------------ */

export type CoresLoja = {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  text: string;
};

export type PaletaLoja = {
  id: string;
  nome: string;
  cores: CoresLoja;
};

const HEX_RE = /^#([0-9a-fA-F]{6})$/;

export function hexValido(v: string): boolean {
  return HEX_RE.test((v ?? "").trim());
}

/**
 * Paletas prontas — harmonias testadas pelo lado do contraste (função abaixo).
 * A empresa pode escolher uma delas ou montar a própria; em ambos os casos a
 * MESMA validação roda no servidor antes de salvar.
 */
export const PALETAS_LOJA: PaletaLoja[] = [
  {
    id: "padrao",
    nome: "Padrão Locô",
    cores: { primary: "#c2410c", secondary: "#0f766e", accent: "#f59e0b", background: "#fafaf9", text: "#1c1917" },
  },
  {
    id: "terracota",
    nome: "Terracota",
    cores: { primary: "#b4522f", secondary: "#7c2d12", accent: "#d97706", background: "#fdf8f5", text: "#292524" },
  },
  {
    id: "marinho",
    nome: "Azul marinho",
    cores: { primary: "#1e3a8a", secondary: "#0f766e", accent: "#0284c7", background: "#f8fafc", text: "#0f172a" },
  },
  {
    id: "floresta",
    nome: "Verde floresta",
    cores: { primary: "#166534", secondary: "#3f6212", accent: "#ca8a04", background: "#f7fdf9", text: "#14532d" },
  },
  {
    id: "ametista",
    nome: "Ametista",
    cores: { primary: "#6d28d9", secondary: "#9d174d", accent: "#db2777", background: "#faf8ff", text: "#2e1065" },
  },
  {
    id: "grafite",
    nome: "Grafite e ouro",
    cores: { primary: "#1f2937", secondary: "#374151", accent: "#b45309", background: "#f9fafb", text: "#111827" },
  },
];

export function resolverPaletaLoja(id: unknown): PaletaLoja {
  return PALETAS_LOJA.find((p) => p.id === id) ?? PALETAS_LOJA[0];
}

/**
 * Contraste da paleta da loja. Exigimos:
 *  * texto sobre o fundo >= 4.5:1 (AA para corpo de texto);
 *  * texto sobre o cartão branco >= 4.5:1;
 *  * rótulo branco sobre o botão (primary) >= 4.5:1.
 * Combinação que deixa texto ou botão ilegível é RECUSADA no servidor — a
 * pré-visualização mostra o mesmo erro antes de salvar.
 */
export function validarCoresLoja(cores: CoresLoja): { ok: boolean; erros: string[] } {
  const erros: string[] = [];
  const valores: [string, string][] = [
    ["cor principal", cores.primary],
    ["cor secundária", cores.secondary],
    ["cor de destaque", cores.accent],
    ["cor de fundo", cores.background],
    ["cor do texto", cores.text],
  ];
  for (const [nome, valor] of valores) {
    if (!hexValido(valor)) erros.push(`A ${nome} precisa ser uma cor hexadecimal válida (#RRGGBB).`);
  }
  if (erros.length) return { ok: false, erros };

  const CONTRASTE_TEXTO = 4.5;
  if (contraste(cores.text, cores.background) < CONTRASTE_TEXTO) {
    erros.push("A cor do texto não é legível sobre a cor de fundo (contraste mínimo AA).");
  }
  if (contraste(cores.text, "#ffffff") < CONTRASTE_TEXTO) {
    erros.push("A cor do texto não é legível sobre os cartões brancos (contraste mínimo AA).");
  }
  if (contraste("#ffffff", cores.primary) < CONTRASTE_TEXTO) {
    erros.push("A cor principal não é legível com texto branco — escolha um tom mais escuro para os botões.");
  }
  return { ok: erros.length === 0, erros };
}

/**
 * Folha de estilo da loja: variáveis próprias (--loja-*), nunca os tokens do
 * painel — personalizar a loja NÃO muda a cor do painel da empresa.
 */
export function cssDaLoja(cores: CoresLoja, buttonStyle: "arredondado" | "quadrado" = "arredondado"): string {
  const raio = buttonStyle === "quadrado" ? "2px" : "9999px";
  return `:root{--loja-primary:${cores.primary};--loja-secondary:${cores.secondary};--loja-accent:${cores.accent};--loja-bg:${cores.background};--loja-text:${cores.text};--loja-card:#ffffff;--loja-radius:${raio};}`;
}

/** Cores efetivas de uma loja (paleta escolhida, sobrescrita pelas cores manuais quando válidas). */
export function coresDaLoja(cfg: {
  theme?: string | null;
  color_primary?: string | null;
  color_secondary?: string | null;
  color_accent?: string | null;
  color_background?: string | null;
  color_text?: string | null;
}): CoresLoja {
  const base = resolverPaletaLoja(cfg.theme).cores;
  const manual: CoresLoja = {
    primary: cfg.color_primary || base.primary,
    secondary: cfg.color_secondary || base.secondary,
    accent: cfg.color_accent || base.accent,
    background: cfg.color_background || base.background,
    text: cfg.color_text || base.text,
  };
  // Se a combinação manual não passa na validação, volta a paleta completa:
  // a loja nunca é publicada com contraste inválido.
  const { ok } = validarCoresLoja(manual);
  return ok ? manual : base;
}

/* ------------------------------------------------------------------ */
/* Totais do pedido                                                    */
/* ------------------------------------------------------------------ */

export type ItemCalculo = {
  qty: number;
  unit_price_cents: number;
  period_qty?: number;
};

/** Mesma fórmula de reservations.ts: qty × período × unitário (sem desconto na loja). */
export function subtotalItem(i: ItemCalculo): number {
  const qty = Math.max(0, Math.floor(Number(i.qty) || 0));
  const unit = Math.max(0, Math.floor(Number(i.unit_price_cents) || 0));
  const period = Math.max(1, Math.floor(Number(i.period_qty) || 1));
  return qty * period * unit;
}

export type TotaisPedido = {
  items_cents: number;
  freight_cents: number;
  total_cents: number;
  signal_cents: number;
};

/** Total do pedido e sinal, pelo percentual configurado (arredondado para baixo). */
export function totaisPedido(
  itens: ItemCalculo[],
  opts: { freightCents?: number; signalPercent?: number } = {},
): TotaisPedido {
  const items = itens.reduce((s, i) => s + subtotalItem(i), 0);
  const freight = Math.max(0, Math.floor(Number(opts.freightCents) || 0));
  const total = items + freight;
  const pct = Math.min(100, Math.max(0, Math.floor(Number(opts.signalPercent) || 0)));
  return {
    items_cents: items,
    freight_cents: freight,
    total_cents: total,
    signal_cents: pct > 0 ? Math.floor((total * pct) / 100) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Regras de data                                                      */
/* ------------------------------------------------------------------ */

export type RegrasData = {
  min_lead_days: number;
  max_days_ahead: number;
};

/** 'YYYY-MM-DD' válido de verdade (calendário real, não só formato). */
export function dataValida(iso: unknown): boolean {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/**
 * Antecedência mínima e horizonte máximo de reservas, em dias corridos.
 * `hoje` vem do servidor (format.today) — o navegador nunca decide o prazo.
 * Devolve a mensagem de erro ou null quando a data é aceitável.
 */
export function validarDataPedido(regras: RegrasData, hoje: string, data: string): string | null {
  if (!dataValida(data)) return "Informe uma data válida.";
  const dia = (v: string) => Date.parse(`${v}T00:00:00Z`);
  const hojeMs = dia(hoje);
  const dataMs = dia(data);
  if (!Number.isFinite(hojeMs) || !Number.isFinite(dataMs)) return "Informe uma data válida.";
  const dias = Math.round((dataMs - hojeMs) / 86400000);
  const min = Math.max(0, Math.floor(regras.min_lead_days || 0));
  const max = Math.max(0, Math.floor(regras.max_days_ahead || 0));
  if (dias < min) {
    return min === 1
      ? "Solicitações precisam de pelo menos 1 dia de antecedência."
      : `Solicitações precisam de pelo menos ${min} dias de antecedência.`;
  }
  if (max > 0 && dias > max) {
    return `Aceitamos solicitações com até ${max} dias de antecedência.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Estados comerciais                                                  */
/* ------------------------------------------------------------------ */

export type StatusDef = { value: string; label: string; tone: "cinza" | "ambar" | "verde" | "azul" | "roxo" | "vermelho" | "terracota" };

/** Estados da solicitação (convenções do sistema, nomes próprios da loja). */
export const ESTADOS_PEDIDO: StatusDef[] = [
  { value: "aguardando_analise", label: "Aguardando análise", tone: "ambar" },
  { value: "aprovada_aguardando_pagamento", label: "Aguardando pagamento", tone: "azul" },
  { value: "confirmada", label: "Confirmada", tone: "verde" },
  { value: "recusada", label: "Recusada", tone: "vermelho" },
  { value: "cancelada", label: "Cancelada", tone: "cinza" },
  { value: "expirada", label: "Expirada", tone: "cinza" },
];

export const ESTADOS_PAGAMENTO: StatusDef[] = [
  { value: "nao_informado", label: "Pagamento não informado", tone: "cinza" },
  { value: "aguardando", label: "Aguardando pagamento", tone: "ambar" },
  { value: "comprovante_enviado", label: "Comprovante enviado", tone: "azul" },
  { value: "em_analise", label: "Pagamento em análise", tone: "azul" },
  { value: "confirmado", label: "Pagamento confirmado", tone: "verde" },
  { value: "recusado", label: "Pagamento recusado", tone: "vermelho" },
  { value: "expirado", label: "Pagamento expirado", tone: "cinza" },
];

/** Estados em que a solicitação ainda pode ser recusada/aprovada pelo painel. */
export const ESTADOS_ABERTOS = ["aguardando_analise", "aprovada_aguardando_pagamento"] as const;

/** Enviar comprovante NUNCA confirma pagamento: exige aceitação da empresa. */
export const PAGAMENTO_APOS_COMPROVANTE = "em_analise" as const;

/* ------------------------------------------------------------------ */
/* Comprovante de pagamento                                            */
/* ------------------------------------------------------------------ */

export const COMPROVANTE_MAX_BYTES = 5 * 1024 * 1024;
export const COMPROVANTE_MIMES = ["image/jpeg", "image/png", "image/webp", "application/pdf"] as const;

/** null = aceito; string = mensagem de recusa. */
export function comprovanteAceito(mime: string, size: number): string | null {
  const m = (mime || "").toLowerCase().split(";")[0].trim();
  if (!(COMPROVANTE_MIMES as readonly string[]).includes(m)) {
    return "Formato não aceito. Envie uma imagem (JPG, PNG ou WEBP) ou PDF.";
  }
  if (!Number.isFinite(size) || size <= 0) return "Arquivo vazio ou corrompido.";
  if (size > COMPROVANTE_MAX_BYTES) {
    return `Arquivo grande demais. O limite é de ${COMPROVANTE_MAX_BYTES / 1024 / 1024} MB.`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Pix (BR Code EMV)                                                   */
/* ------------------------------------------------------------------ */

/** CRC16-CCITT (0x1021, init 0xFFFF) — exigido pelo padrão do Banco Central. */
export function crc16Ccitt(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

const semAcento = (v: string) =>
  (v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^A-Za-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** Campo EMV com tamanho fixo de 2 dígitos. */
const emv = (id: string, valor: string) => `${id}${String(valor.length).padStart(2, "0")}${valor}`;

export type DadosPix = {
  chave: string;
  nome: string;
  cidade: string;
  /** Valor em centavos; 0/ausente gera chave sem valor (pagador informa). */
  valorCents?: number;
  /** Identificador da transação (loja + pedido). Apenas [A-Za-z0-9]. */
  identificador?: string;
};

/**
 * Payload Pix (copia e cola) com o valor EXATO do pedido.
 * Campo obrigatório do padrão: chave, nome do recebedor (até 25), cidade
 * (até 15), moeda 986 (BRL), país BR, CRC16 válido. Não inventa valor nem
 * identificador fora do permitido.
 */
export function pixCopiaECola(dados: DadosPix): { ok: true; payload: string } | { ok: false; erro: string } {
  const chave = (dados.chave ?? "").trim();
  if (!chave) return { ok: false, erro: "Configure a chave Pix da loja antes de gerar o código." };
  const nome = semAcento(dados.nome).toUpperCase().slice(0, 25);
  const cidade = semAcento(dados.cidade).toUpperCase().slice(0, 15);
  if (!nome) return { ok: false, erro: "Informe o nome do recebedor Pix." };
  if (!cidade) return { ok: false, erro: "Informe a cidade do recebedor Pix." };

  const valor = Math.floor(Number(dados.valorCents) || 0);
  const txid = semAcento(dados.identificador ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 25) || "***";

  const gui = emv("00", "br.gov.bcb.pix") + emv("01", chave);
  const campos = [
    emv("00", "01"),
    emv("26", gui),
    emv("52", "0000"),
    emv("53", "986"),
    valor > 0 ? emv("54", String(valor)) : "",
    emv("58", "BR"),
    emv("59", nome),
    emv("60", cidade),
    emv("62", emv("05", txid)),
  ].filter(Boolean);
  const corpo = campos.join("");
  const base = `${corpo}6304`;
  return { ok: true, payload: `${base}${crc16Ccitt(base)}` };
}
