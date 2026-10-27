import "server-only";
/**
 * Loja Virtual — persistência e transições de estado (lado do painel).
 *
 * Regras que este módulo garante:
 *  * TODA leitura/escrita é escopada pelo company_id informado — nenhum id
 *    vindo daqui é usado sem o WHERE company_id = ? (isolamento por tenant);
 *  * publicação/revogação acontecem AQUI: loja fora do ar, pausada ou empresa
 *    sem o recurso liberado não atende a API pública (loja-publico.ts);
 *  * aprovar uma solicitação passa pelo MESMO caminho do painel: checkConflicts
 *    + stockVersion/commitStockBatch (CAS) + writeRental — sem estoque paralelo;
 *  * recusar/cancelar/expirar devolvem o estoque ao cancelar a reserva vinculada;
 *  * o comprovante só existe como linha em store_receipts apontando `files` —
 *    sem essa linha o arquivo não é servido a ninguém.
 */
import { all, insert, isUniqueViolation, nextNumber, one, run, scalar } from "./db";
import {
  coresDaLoja,
  resolverPaletaLoja,
  subtotalItem,
  totaisPedido,
  validarCoresLoja,
  validarSlug,
  type CoresLoja,
  type StatusDef,
  ESTADOS_PEDIDO,
  ESTADOS_PAGAMENTO,
} from "./loja";
import { settingsDaEmpresa, type Settings } from "./settings";
import { checkConflicts, conflictsMessage, holdWindow, loadSpecs, explodeLine, isKit } from "./stock";
import { stockVersion, writeRental, STOCK_CHANGED } from "./stock-write";
import { recalcReservation, syncOperations } from "./reservations";
import { aplicarPrecos } from "./pricing";
import { addDays, nowLocal, today } from "./format";

/* ------------------------------------------------------------------ */
/* Tipos                                                               */
/* ------------------------------------------------------------------ */

export type LojaRow = {
  id: number;
  company_id: number;
  slug: string;
  status: "desativada" | "rascunho" | "publicada";
  paused: number;
  pause_message: string | null;
  display_name: string;
  logo_url: string | null;
  banner_url: string | null;
  description: string;
  presentation: string;
  phone: string;
  whatsapp: string;
  address: string;
  city: string;
  region: string;
  hours: string;
  instagram: string;
  extra_info: string;
  theme: string;
  color_primary: string;
  color_secondary: string;
  color_accent: string;
  color_background: string;
  color_text: string;
  button_style: "arredondado" | "quadrado";
  show_banner: number;
  show_about: number;
  show_delivery: number;
  show_faq: number;
  show_contact: number;
  about_text: string;
  delivery_text: string;
  faq_json: string;
  notice_text: string;
  seo_title: string;
  seo_description: string;
  seo_image_url: string | null;
  mode: "orcamento" | "manual" | "automatica";
  hide_prices: number;
  min_lead_days: number;
  max_days_ahead: number;
  min_order_cents: number;
  offer_delivery: number;
  offer_pickup: number;
  freight_type: "comum" | "locacao";
  freight_pending_ok: number;
  signal_percent: number;
  payment_deadline_h: number;
  require_terms: number;
  terms_text: string;
  cancellation_text: string;
  privacy_text: string;
  success_message: string;
  pix_enabled: number;
  pix_key: string;
  pix_holder: string;
  pix_city: string;
  pix_institution: string;
  pix_instructions: string;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export type PedidoRow = {
  id: number;
  company_id: number;
  number: string;
  kind: "orcamento" | "reserva";
  status: string;
  payment_status: string;
  customer_id: number;
  customer_name: string;
  customer_phone: string | null;
  customer_email: string | null;
  customer_doc: string | null;
  event_date: string;
  event_time: string | null;
  delivery_at: string | null;
  pickup_at: string | null;
  needs_delivery: number;
  address: string | null;
  district: string | null;
  city: string | null;
  zip: string | null;
  notes: string | null;
  freight_cents: number;
  freight_status: string;
  items_cents: number;
  total_cents: number;
  signal_cents: number;
  payment_deadline_at: string | null;
  terms_accepted: number;
  reservation_id: number | null;
  quote_id: number | null;
  created_at: string;
  updated_at: string;
};

/* ------------------------------------------------------------------ */
/* Configuração                                                        */
/* ------------------------------------------------------------------ */

export async function lojaDaEmpresa(companyId: number): Promise<LojaRow | null> {
  return (await one<LojaRow>(`SELECT * FROM company_stores WHERE company_id = ?`, [companyId])) ?? null;
}

/** Colunas aceitas no UPDATE da identidade/visual (whitelist = não passa lixo). */
const COLS_IDENTIDADE = [
  "slug", "display_name", "logo_url", "banner_url", "description", "presentation",
  "phone", "whatsapp", "address", "city", "region", "hours", "instagram", "extra_info",
  "theme", "color_primary", "color_secondary", "color_accent", "color_background",
  "color_text", "button_style", "show_banner", "show_about", "show_delivery",
  "show_faq", "show_contact", "about_text", "delivery_text", "faq_json", "notice_text",
  "seo_title", "seo_description", "seo_image_url",
] as const;

const COLS_COMERCIAIS = [
  "mode", "hide_prices", "min_lead_days", "max_days_ahead", "min_order_cents",
  "offer_delivery", "offer_pickup", "freight_type", "freight_pending_ok",
  "signal_percent", "payment_deadline_h", "require_terms", "terms_text",
  "cancellation_text", "privacy_text", "success_message",
] as const;

const COLS_PIX = ["pix_enabled", "pix_key", "pix_holder", "pix_city", "pix_institution", "pix_instructions"] as const;

function escalaBool(v: unknown): number {
  return v === true || v === 1 || v === "1" ? 1 : 0;
}

function escalaInteiro(v: unknown, min: number, max: number, padrao = 0): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return padrao;
  return Math.min(max, Math.max(min, n));
}

function texto(v: unknown, max = 4000): string {
  return String(v ?? "").trim().slice(0, max);
}

/**
 * Cria OU atualiza a loja da empresa. A escrita é um UPSERT pela chave
 * company_id (UNIQUE): uma empresa só tem uma loja, e nenhuma outra empresa é
 * alcançável por este caminho.
 */
export async function salvarIdentidadeLoja(
  companyId: number,
  dados: Record<string, unknown>,
): Promise<{ ok: true; loja: LojaRow } | { ok: false; erro: string }> {
  const atual = await lojaDaEmpresa(companyId);

  // slug: só valida/troca quando enviado — e sempre checa colisão com outra empresa
  let slug = atual?.slug ?? "";
  if ("slug" in dados) {
    const bruto = texto(dados.slug, 80);
    const candidato = bruto === slug ? slug : bruto;
    if (candidato) {
      const r = validarSlug(candidato);
      if (!r.ok) return { ok: false, erro: r.erro! };
      const dono = await one<{ company_id: number }>(`SELECT company_id FROM company_stores WHERE slug = ?`, [candidato]);
      if (dono && dono.company_id !== companyId) {
        return { ok: false, erro: "Este identificador já está em uso por outra loja. Escolha outro." };
      }
      slug = candidato;
    } else if (atual) {
      return { ok: false, erro: "Informe o identificador público da loja." };
    }
  } else if (!atual) {
    return { ok: false, erro: "Informe o identificador público da loja." };
  }
  if (!slug) return { ok: false, erro: "Informe o identificador público da loja." };

  /* Atualização PARCIAL: campo não enviado preserva o valor gravado (a aba
   * Publicação manda só o slug, por exemplo). Nada volta vazio por engano. */
  const campo = (chave: string, max = 4000): string =>
    chave in dados ? texto(dados[chave], max) : texto((atual as any)?.[chave] ?? "", max);
  const flag = (chave: string, padrao: number): number =>
    chave in dados ? escalaBool(dados[chave]) : Number((atual as any)?.[chave] ?? padrao);
  const url = (chave: string): string | null => campo(chave, 300) || null;

  const theme = campo("theme", 40) || "padrao";
  const paleta = resolverPaletaLoja(theme).cores;
  const cores: CoresLoja = {
    primary: campo("color_primary", 7) || paleta.primary,
    secondary: campo("color_secondary", 7) || paleta.secondary,
    accent: campo("color_accent", 7) || paleta.accent,
    background: campo("color_background", 7) || paleta.background,
    text: campo("color_text", 7) || paleta.text,
  };
  const coresOk = validarCoresLoja(cores);
  if (!coresOk.ok) return { ok: false, erro: coresOk.erros.join(" ") };

  const valores: Record<string, unknown> = {
    slug,
    display_name: campo("display_name", 80),
    logo_url: url("logo_url"),
    banner_url: url("banner_url"),
    description: campo("description", 400),
    presentation: campo("presentation", 2000),
    phone: campo("phone", 40),
    whatsapp: campo("whatsapp", 40),
    address: campo("address", 200),
    city: campo("city", 80),
    region: campo("region", 80),
    hours: campo("hours", 200),
    instagram: campo("instagram", 120),
    extra_info: campo("extra_info", 2000),
    theme,
    color_primary: cores.primary,
    color_secondary: cores.secondary,
    color_accent: cores.accent,
    color_background: cores.background,
    color_text: cores.text,
    button_style: "button_style" in dados ? (dados.button_style === "quadrado" ? "quadrado" : "arredondado") : atual?.button_style ?? "arredondado",
    show_banner: flag("show_banner", 1),
    show_about: flag("show_about", 1),
    show_delivery: flag("show_delivery", 1),
    show_faq: flag("show_faq", 1),
    show_contact: flag("show_contact", 1),
    about_text: campo("about_text", 4000),
    delivery_text: campo("delivery_text", 4000),
    faq_json: campo("faq_json", 8000) || "[]",
    notice_text: campo("notice_text", 500),
    seo_title: campo("seo_title", 70),
    seo_description: campo("seo_description", 170),
    seo_image_url: url("seo_image_url"),
  };
  try {
    if (!atual) {
      await run(
        `INSERT INTO company_stores (company_id, ${COLS_IDENTIDADE.join(",")})
         VALUES (?, ${COLS_IDENTIDADE.map(() => "?").join(",")})`,
        [companyId, ...COLS_IDENTIDADE.map((c) => valores[c] ?? null)],
      );
    } else {
      await run(
        `UPDATE company_stores SET ${COLS_IDENTIDADE.map((c) => `${c}=?`).join(",")}, updated_at=datetime('now','localtime')
          WHERE company_id = ?`,
        [...COLS_IDENTIDADE.map((c) => valores[c] ?? null), companyId],
      );
    }
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, erro: "Este identificador já está em uso. Escolha outro." };
    throw e;
  }
  const loja = await lojaDaEmpresa(companyId);
  if (!loja) return { ok: false, erro: "Não foi possível salvar a loja." };
  return { ok: true, loja };
}

export async function salvarRegrasLoja(companyId: number, dados: Record<string, unknown>): Promise<void> {
  const loja = await lojaDaEmpresa(companyId);
  if (!loja) throw new Error("Loja não encontrada.");
  /* Atualização PARCIAL: campo não enviado preserva o gravado. Um PATCH com
   * só { mode } não pode apagar modalidades de entrega/retirada nem exigir
   * termos sem querer. */
  const flag = (chave: "hide_prices" | "offer_delivery" | "offer_pickup" | "freight_pending_ok" | "require_terms"): number =>
    chave in dados ? escalaBool(dados[chave]) : Number(loja[chave] ?? 0);
  const campo = (chave: "terms_text" | "cancellation_text" | "privacy_text" | "success_message", max: number): string =>
    chave in dados ? texto(dados[chave], max) : String((loja as any)[chave] ?? "");
  const valores: Record<string, unknown> = {
    mode: ["orcamento", "manual", "automatica"].includes(String(dados.mode)) ? String(dados.mode) : loja.mode,
    hide_prices: flag("hide_prices"),
    min_lead_days: escalaInteiro(dados.min_lead_days, 0, 365, loja.min_lead_days),
    max_days_ahead: escalaInteiro(dados.max_days_ahead, 0, 730, loja.max_days_ahead),
    min_order_cents: escalaInteiro(dados.min_order_cents, 0, 100_000_000, loja.min_order_cents),
    offer_delivery: flag("offer_delivery"),
    offer_pickup: flag("offer_pickup"),
    freight_type: dados.freight_type === "comum" || dados.freight_type === "locacao" ? dados.freight_type : loja.freight_type,
    freight_pending_ok: flag("freight_pending_ok"),
    signal_percent: escalaInteiro(dados.signal_percent, 0, 100, loja.signal_percent),
    payment_deadline_h: escalaInteiro(dados.payment_deadline_h, 1, 720, loja.payment_deadline_h),
    require_terms: flag("require_terms"),
    terms_text: campo("terms_text", 8000),
    cancellation_text: campo("cancellation_text", 4000),
    privacy_text: campo("privacy_text", 4000),
    success_message: campo("success_message", 1000),
  };
  await run(
    `UPDATE company_stores SET ${COLS_COMERCIAIS.map((c) => `${c}=?`).join(",")}, updated_at=datetime('now','localtime')
      WHERE company_id = ?`,
    [...COLS_COMERCIAIS.map((c) => valores[c] ?? null), companyId],
  );
}

export async function salvarPixLoja(companyId: number, dados: Record<string, unknown>): Promise<void> {
  const valores: Record<string, unknown> = {
    pix_enabled: escalaBool(dados.pix_enabled),
    pix_key: texto(dados.pix_key, 120),
    pix_holder: texto(dados.pix_holder, 80),
    pix_city: texto(dados.pix_city, 40),
    pix_institution: texto(dados.pix_institution, 80),
    pix_instructions: texto(dados.pix_instructions, 2000),
  };
  await run(
    `UPDATE company_stores SET ${COLS_PIX.map((c) => `${c}=?`).join(",")}, updated_at=datetime('now','localtime')
      WHERE company_id = ?`,
    [...COLS_PIX.map((c) => valores[c] ?? null), companyId],
  );
}

/* ------------------------------------------------------------------ */
/* Checklist de publicação                                             */
/* ------------------------------------------------------------------ */

export type ItemChecklist = { chave: string; label: string; ok: boolean; detalhe?: string; essencial?: boolean };

/**
 * Antes da primeira publicação: o que ainda falta. Sem item essencial ok,
 * `publicarLoja` recusa — a loja nunca vai ao ar incompleta.
 */
export async function checklistLoja(companyId: number): Promise<{ ok: boolean; itens: ItemChecklist[] }> {
  const loja = await lojaDaEmpresa(companyId);
  const itens: ItemChecklist[] = [];
  const slugOk = !!loja && validarSlug(loja.slug).ok;
  itens.push({
    chave: "slug",
    label: "Identificador público definido",
    ok: slugOk,
    detalhe: slugOk ? `/loja/${loja!.slug}` : "Escolha o endereço da loja em Publicação.",
  });
  itens.push({
    chave: "nome",
    label: "Nome exibido na loja",
    ok: !!loja && loja.display_name.trim().length > 0,
    detalhe: "É o nome que o cliente vê no topo da página.",
  });
  const contatoOk = !!loja && (!!loja.phone.trim() || !!loja.whatsapp.trim());
  itens.push({
    chave: "contato",
    label: "Telefone ou WhatsApp de atendimento",
    ok: contatoOk,
    detalhe: "O cliente precisa de um canal para tirar dúvidas.",
  });
  const cores = coresDaLoja(loja ?? ({} as LojaRow));
  itens.push({
    chave: "cores",
    label: "Paleta visual com contraste legível",
    ok: validarCoresLoja(cores).ok,
    detalhe: "Texto, fundo e botões precisam ser legíveis (AA).",
  });
  const publicados = await scalar<number>(
    `SELECT COUNT(*) FROM store_products sp
       JOIN products p ON p.id = sp.product_id AND p.company_id = sp.company_id
      WHERE sp.company_id = ? AND sp.published = 1 AND p.active = 1`,
    [companyId],
  );
  itens.push({
    chave: "produtos",
    label: "Ao menos um produto publicado",
    ok: Number(publicados || 0) > 0,
    essencial: false,
    detalhe: "Publique produtos em Produtos publicados (a loja pode no ar sem catálogo, mas não vende).",
  });
  const precisaPix = !!loja && loja.signal_percent > 0;
  const pixOk = !!loja && (!precisaPix || (loja.pix_enabled === 1 && !!loja.pix_key.trim() && !!loja.pix_holder.trim()));
  itens.push({
    chave: "pix",
    label: precisaPix ? "Dados Pix (exigidos: há sinal obrigatório)" : "Dados Pix (opcional)",
    ok: pixOk,
    detalhe: precisaPix ? "Configure em Pagamento por Pix." : "Configure em Pagamento por Pix se quiser receber por lá.",
  });
  return {
    ok: itens.filter((i) => i.essencial !== false).every((i) => i.ok),
    itens,
  };
}

/** Publica ou tira do ar. Publicar exige checklist completo. */
export async function publicarLoja(
  companyId: number,
  publicar: boolean,
): Promise<{ ok: true; loja: LojaRow } | { ok: false; erro: string; itens?: ItemChecklist[] }> {
  const loja = await lojaDaEmpresa(companyId);
  if (!loja) return { ok: false, erro: "Ainda não existe loja configurada para esta empresa." };
  if (publicar) {
    const { ok, itens } = await checklistLoja(companyId);
    if (!ok) {
      const falta = itens.filter((i) => i.essencial !== false && !i.ok).map((i) => i.label);
      return { ok: false, erro: `Antes de publicar, complete: ${falta.join("; ")}.`, itens };
    }
    await run(
      `UPDATE company_stores SET status='publicada', paused=0, published_at=COALESCE(published_at, datetime('now','localtime')),
              updated_at=datetime('now','localtime') WHERE company_id = ?`,
      [companyId],
    );
  } else {
    await run(
      `UPDATE company_stores SET status='desativada', updated_at=datetime('now','localtime') WHERE company_id = ?`,
      [companyId],
    );
  }
  const novo = await lojaDaEmpresa(companyId);
  return { ok: true, loja: novo! };
}

/** Pausa temporária: mantém tudo configurado, mas não aceita novos pedidos. */
export async function pausarLoja(companyId: number, pausado: boolean, mensagem = ""): Promise<void> {
  await run(
    `UPDATE company_stores SET paused=?, pause_message=?, updated_at=datetime('now','localtime') WHERE company_id = ?`,
    [pausado ? 1 : 0, texto(mensagem, 300), companyId],
  );
}

/* ------------------------------------------------------------------ */
/* Produtos publicados                                                 */
/* ------------------------------------------------------------------ */

export type ProdutoLoja = {
  product_id: number;
  code: string;
  name: string;
  kind: string;
  active: number;
  photo: string | null;
  category: string | null;
  rent_price_cents: number;
  pricing_mode: string | null;
  description: string | null;
  published: number;
  public_price_cents: number | null;
  public_name: string | null;
  public_description: string | null;
  photo_url: string | null;
  featured: number;
  sort_order: number;
  max_qty: number | null;
  /** Preço efetivamente exibido na loja (loja ou sistema). */
  preco_loja_cents: number;
  /** O que impede a publicação deste item, se houver. */
  incompleto: string | null;
};

/**
 * Todos os produtos da empresa com a sobreposição da loja + o que falta para
 * publicar. Produtos sem foto/preço NUNCA são publicados silenciosamente:
 * `incompleto` diz o que corrigir.
 */
export async function produtosDaLoja(companyId: number): Promise<ProdutoLoja[]> {
  const rows = await all<any>(
    `SELECT p.id AS product_id, p.code, p.name, p.kind, p.active, p.photo, p.rent_price_cents,
            p.pricing_mode, p.description, c.name AS category,
            COALESCE(sp.published, 0) AS published, sp.public_price_cents, sp.public_name,
            sp.public_description, sp.photo_url, COALESCE(sp.featured, 0) AS featured,
            COALESCE(sp.sort_order, 0) AS sort_order, sp.max_qty
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN store_products sp ON sp.product_id = p.id AND sp.company_id = p.company_id
      WHERE p.company_id = ? AND p.is_demo = 0
      ORDER BY p.name`,
    [companyId],
  );
  return rows.map((r) => {
    const preco = r.public_price_cents ?? r.rent_price_cents ?? 0;
    const problemas: string[] = [];
    if (!r.photo && !r.photo_url) problemas.push("sem foto");
    if (!(preco > 0)) problemas.push("sem preço");
    if (r.active !== 1) problemas.push("produto inativo");
    if (r.kind === "kit") {
      // kits podem ser publicados: a disponibilidade é derivada dos componentes
    }
    return {
      ...r,
      preco_loja_cents: Number(preco) || 0,
      incompleto: problemas.length ? problemas.join(", ") : null,
    } as ProdutoLoja;
  });
}

/** Grava a configuração comercial da loja para UM produto da própria empresa. */
export async function salvarProdutoLoja(
  companyId: number,
  productId: number,
  dados: Record<string, unknown>,
): Promise<{ ok: boolean; erro?: string }> {
  const produto = await one<{ id: number }>(`SELECT id FROM products WHERE id = ? AND company_id = ?`, [productId, companyId]);
  if (!produto) return { ok: false, erro: "Produto não encontrado." };

  const publicado = escalaBool(dados.published);
  if (publicado) {
    const preco = dados.public_price_cents === undefined || dados.public_price_cents === null || dados.public_price_cents === ""
      ? null
      : escalaInteiro(dados.public_price_cents, 0, 100_000_000, 0);
    const sistema = await scalar<number>(`SELECT rent_price_cents FROM products WHERE id = ?`, [productId]);
    if (preco === null && !(Number(sistema) > 0)) {
      return { ok: false, erro: "Este produto não tem preço: defina um preço para a loja antes de publicar." };
    }
  }

  // foto: só substitui quando um upload veio agora — caso contrário preserva a atual
  const atual = await one<{ photo_url: string | null }>(
    `SELECT photo_url FROM store_products WHERE company_id = ? AND product_id = ?`,
    [companyId, productId],
  );
  const valores = {
    published: publicado,
    public_price_cents:
      dados.public_price_cents === undefined || dados.public_price_cents === null || dados.public_price_cents === ""
        ? null
        : escalaInteiro(dados.public_price_cents, 0, 100_000_000, 0),
    public_name: texto(dados.public_name, 120) || null,
    public_description: texto(dados.public_description, 4000) || null,
    photo_url: "photo_url" in dados ? (texto(dados.photo_url, 300) || null) : (atual?.photo_url ?? null),
    featured: escalaBool(dados.featured),
    sort_order: escalaInteiro(dados.sort_order, 0, 9999, 0),
    max_qty: dados.max_qty === undefined || dados.max_qty === null || dados.max_qty === "" ? null : escalaInteiro(dados.max_qty, 1, 9999, 1),
  };
  await run(
    `INSERT INTO store_products (company_id, product_id, published, public_price_cents, public_name,
            public_description, photo_url, featured, sort_order, max_qty)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(company_id, product_id) DO UPDATE SET
       published=excluded.published, public_price_cents=excluded.public_price_cents,
       public_name=excluded.public_name, public_description=excluded.public_description,
       photo_url=excluded.photo_url, featured=excluded.featured, sort_order=excluded.sort_order,
       max_qty=excluded.max_qty, updated_at=datetime('now','localtime')`,
    [
      companyId, productId, valores.published, valores.public_price_cents, valores.public_name,
      valores.public_description, valores.photo_url, valores.featured, valores.sort_order, valores.max_qty,
    ],
  );
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Visão geral                                                         */
/* ------------------------------------------------------------------ */

export type ResumoLoja = {
  status: string;
  publicada: boolean;
  total: number;
  aguardando: number;
  orcamentos: number;
  aguardandoPagamento: number;
  comprovantes: number;
};

export async function resumoLoja(companyId: number): Promise<ResumoLoja> {
  await expirarPedidos(companyId);
  const r = await one<any>(
    `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='aguardando_analise' THEN 1 ELSE 0 END) AS aguardando,
        SUM(CASE WHEN kind='orcamento' AND status NOT IN ('recusada','cancelada','expirada') THEN 1 ELSE 0 END) AS orcamentos,
        SUM(CASE WHEN status='aprovada_aguardando_pagamento' THEN 1 ELSE 0 END) AS pagamento,
        SUM(CASE WHEN payment_status IN ('comprovante_enviado','em_analise') THEN 1 ELSE 0 END) AS comprovantes
       FROM store_orders WHERE company_id = ?`,
    [companyId],
  );
  const loja = await lojaDaEmpresa(companyId);
  return {
    status: loja?.status ?? "desativada",
    publicada: loja?.status === "publicada",
    total: Number(r?.total ?? 0),
    aguardando: Number(r?.aguardando ?? 0),
    orcamentos: Number(r?.orcamentos ?? 0),
    aguardandoPagamento: Number(r?.pagamento ?? 0),
    comprovantes: Number(r?.comprovantes ?? 0),
  };
}

/* ------------------------------------------------------------------ */
/* Pedidos (painel)                                                    */
/* ------------------------------------------------------------------ */

export function rotulosEstado(): { estados: StatusDef[]; pagamentos: StatusDef[] } {
  return { estados: ESTADOS_PEDIDO, pagamentos: ESTADOS_PAGAMENTO };
}

export async function listarPedidos(companyId: number, filtro = ""): Promise<(PedidoRow & { item_count: number })[]> {
  await expirarPedidos(companyId);
  const params: any[] = [companyId];
  let where = "";
  if (filtro === "pendentes") where = `AND o.status IN ('aguardando_analise','aprovada_aguardando_pagamento')`;
  else if (filtro === "comprovantes") where = `AND o.payment_status IN ('comprovante_enviado','em_analise')`;
  else if (filtro === "confirmados") where = `AND o.status = 'confirmada'`;
  else if (filtro === "encerrados") where = `AND o.status IN ('recusada','cancelada','expirada')`;
  return await all<any>(
    `SELECT o.*, (SELECT COUNT(*) FROM store_order_items i WHERE i.store_order_id = o.id) AS item_count
       FROM store_orders o WHERE o.company_id = ? ${where}
      ORDER BY o.created_at DESC, o.id DESC LIMIT 300`,
    params,
  );
}

export async function pedidoDaEmpresa(companyId: number, orderId: number): Promise<PedidoRow | null> {
  await expirarPedidos(companyId);
  return (await one<PedidoRow>(`SELECT * FROM store_orders WHERE id = ? AND company_id = ?`, [orderId, companyId])) ?? null;
}

export async function itensDoPedido(companyId: number, orderId: number) {
  return await all<any>(
    `SELECT * FROM store_order_items WHERE store_order_id = ? AND company_id = ? ORDER BY id`,
    [orderId, companyId],
  );
}

export async function eventosDoPedido(companyId: number, orderId: number) {
  return await all<any>(
    `SELECT * FROM store_order_events WHERE store_order_id = ? AND company_id = ? ORDER BY id DESC LIMIT 100`,
    [orderId, companyId],
  );
}

export async function comprovantesDoPedido(companyId: number, orderId: number) {
  return await all<any>(
    `SELECT r.* FROM store_receipts r
       JOIN store_orders o ON o.id = r.store_order_id
      WHERE r.store_order_id = ? AND r.company_id = ? AND o.company_id = ?
      ORDER BY r.id DESC`,
    [orderId, companyId, companyId],
  );
}

/** Grava um evento do histórico (idempotente por conteúdo imediato). */
export async function registrarEvento(
  companyId: number,
  orderId: number,
  event: string,
  description: string,
  actor = "cliente",
): Promise<void> {
  await run(
    `INSERT INTO store_order_events (store_order_id, company_id, event, description, actor) VALUES (?,?,?,?,?)`,
    [orderId, companyId, event, description.slice(0, 300), actor.slice(0, 60)],
  );
}

/* ------------------------------------------------------------------ */
/* Expiração de pagamento (libera estoque sem cron)                     */
/* ------------------------------------------------------------------ */

/**
 * Pedidos aprovados e não pagos dentro do prazo viram `expirada` e a reserva
 * vinculada é cancelada (estoque liberado). Chamada nas leituras do painel e
 * no acompanhamento público: o estado é DERIVADO do tempo, como a cortesia —
 * nenhum job é necessário para a regra valer.
 */
export async function expirarPedidos(companyId: number): Promise<number> {
  const vencidos = await all<PedidoRow>(
    `SELECT * FROM store_orders
      WHERE company_id = ? AND status = 'aprovada_aguardando_pagamento'
        AND payment_deadline_at IS NOT NULL AND payment_deadline_at < ?`,
    [companyId, nowLocal()],
  );
  for (const p of vencidos) {
    await run(
      `UPDATE store_orders SET status='expirada', payment_status='expirado', updated_at=datetime('now','localtime')
        WHERE id = ? AND company_id = ? AND status='aprovada_aguardando_pagamento'`,
      [p.id, companyId],
    );
    if (p.reservation_id) {
      await run(
        `UPDATE reservations SET status='cancelada', cancel_reason='Prazo de pagamento da loja expirado', updated_at=datetime('now','localtime')
          WHERE id = ? AND company_id = ? AND status IN ('pre_reserva','confirmada')`,
        [p.reservation_id, companyId],
      );
    }
    await registrarEvento(companyId, p.id, "expirado", "Prazo de pagamento expirou; reserva vinculada cancelada.", "sistema");
  }
  return vencidos.length;
}

/* ------------------------------------------------------------------ */
/* Transições comerciais                                               */
/* ------------------------------------------------------------------ */

async function dadosParaReserva(companyId: number, p: PedidoRow) {
  const specs = await loadSpecs(companyId);
  const itensBrutos = await itensDoPedido(companyId, p.id);
  const preco = await aplicarPrecos(
    itensBrutos.map((i: any) => ({ product_id: i.product_id, qty: i.qty, unit_price_cents: i.unit_price_cents })),
    { delivery_at: p.delivery_at, pickup_at: p.pickup_at },
    companyId,
  );
  return { specs, itensBrutos, preco };
}

/**
 * Cria a reserva de UM pedido da loja usando o caminho oficial do painel:
 * versão do estoque + conflitos + escrita em lote (CAS). Devolve o id ou a
 * mensagem de conflito — nunca grava estoque pela metade.
 */
async function criarReservaDoPedido(
  companyId: number,
  p: PedidoRow,
  userId: number | null,
): Promise<{ ok: true; id: number; number: string } | { ok: false; erro: string }> {
  const version = await stockVersion(companyId);
  const { preco } = await dadosParaReserva(companyId, p);
  const conflitos = await checkConflicts(
    preco.map((i) => ({ product_id: i.product_id, qty: i.qty })),
    p.delivery_at ?? `${p.event_date}T08:00`,
    p.pickup_at ?? addDays(p.event_date, 1) + "T18:00",
    null,
    {},
    companyId,
  );
  if (conflitos.length) return { ok: false, erro: conflictsMessage(conflitos) };

  try {
    const salvo = await writeRental(
      companyId,
      version,
      {
        customer_id: p.customer_id,
        status: "pre_reserva",
        event_date: p.event_date,
        event_time: p.event_time ?? "",
        address: p.address ?? "",
        district: p.district ?? "",
        city: p.city ?? "",
        delivery_at: p.delivery_at ?? `${p.event_date}T08:00`,
        pickup_at: p.pickup_at ?? `${addDays(p.event_date, 1)}T18:00`,
        needs_delivery: p.needs_delivery,
        needs_pickup: 1,
        needs_assembly: 0,
        needs_disassembly: 0,
        freight_cents: p.freight_cents,
        assembly_cents: 0,
        disassembly_cents: 0,
        other_cents: 0,
        discount_cents: 0,
        notes: [p.notes ?? "", "(Solicitação da Loja Virtual)"].filter(Boolean).join(" ").slice(0, 2000),
        stock_override: 0,
        stock_consider_preparation: 1,
        created_by: userId,
      },
      preco.map((i) => ({
        product_id: i.product_id,
        qty: i.qty,
        unit_price_cents: i.unit_price_cents,
        discount_cents: i.discount_cents,
        pricing_mode: i.pricing_mode,
        period_qty: i.period_qty,
      })),
    );
    await run(
      `INSERT INTO deposits (reservation_id, amount_cents, status, company_id) VALUES (?,0,'nao_recebida',?)`,
      [salvo.id, companyId],
    );
    await recalcReservation(salvo.id);
    await syncOperations(salvo.id);
    await run(`UPDATE reservations SET store_order_id = ? WHERE id = ? AND company_id = ?`, [p.id, salvo.id, companyId]);
    return { ok: true, ...salvo };
  } catch (e) {
    if ((e as Error).message === STOCK_CHANGED) return { ok: false, erro: STOCK_CHANGED };
    throw e;
  }
}

/**
 * Aprovação: cria a reserva (se ainda não existe) e move o pedido para
 * `aprovada_aguardando_pagamento` (quando há sinal a pagar) ou `confirmada`.
 * Falha de estoque devolve a mensagem — nada é gravado e o pedido continua
 * aguardando análise.
 */
export async function aprovarPedido(
  companyId: number,
  orderId: number,
  userId: number | null,
): Promise<{ ok: true; pedido: PedidoRow } | { ok: false; erro: string }> {
  const p = await pedidoDaEmpresa(companyId, orderId);
  if (!p) return { ok: false, erro: "Solicitação não encontrada." };
  if (p.status !== "aguardando_analise") return { ok: false, erro: "Esta solicitação não está aguardando análise." };

  let reserva = p.reservation_id;
  if (!reserva) {
    const criada = await criarReservaDoPedido(companyId, p, userId);
    if (!criada.ok) return criada;
    reserva = criada.id;
  }

  const loja = await lojaDaEmpresa(companyId);
  const sinalPct = loja?.signal_percent ?? 0;
  const temSinal = sinalPct > 0;
  const signal = temSinal ? Math.floor((p.total_cents * sinalPct) / 100) : 0;
  const deadline = temSinal ? nowLocal().slice(0, 16) : null;
  const novoStatus = temSinal ? "aprovada_aguardando_pagamento" : "confirmada";

  await run(
    `UPDATE store_orders SET status=?, payment_status=?, signal_cents=?, payment_deadline_at=?,
            reservation_id=?, updated_at=datetime('now','localtime')
      WHERE id = ? AND company_id = ?`,
    [
      novoStatus,
      temSinal ? "aguardando" : "nao_informado",
      signal,
      temSinal ? agoraMaisHoras(loja?.payment_deadline_h ?? 48) : deadline,
      reserva,
      orderId,
      companyId,
    ],
  );
  if (!temSinal) {
    await run(`UPDATE reservations SET status='confirmada', updated_at=datetime('now','localtime') WHERE id = ? AND company_id = ?`, [
      reserva,
      companyId,
    ]);
    await recalcReservation(reserva);
    await emailConfirmacao(companyId, reserva);
  }
  await registrarEvento(companyId, orderId, "aprovado", temSinal
    ? `Aprovada; aguardando sinal de ${signal} centavos.`
    : "Aprovada e confirmada.", `usuario:${userId ?? "sistema"}`);
  const depois = await pedidoDaEmpresa(companyId, orderId);
  return { ok: true, pedido: depois! };
}

/** Cria o orçamento a partir do pedido (modo orçamento), vinculado ao pedido. */
export async function criarOrcamentoDoPedido(
  companyId: number,
  orderId: number,
  userId: number | null,
): Promise<{ ok: true; quoteId: number } | { ok: false; erro: string }> {
  const p = await pedidoDaEmpresa(companyId, orderId);
  if (!p) return { ok: false, erro: "Solicitação não encontrada." };
  if (p.quote_id) return { ok: false, erro: "Este pedido já virou um orçamento." };
  const loja = await lojaDaEmpresa(companyId);
  const number = await nextNumber("quotes", loja?.slug?.slice(0, 4).toUpperCase() || "LOJ");
  const { preco } = await dadosParaReserva(companyId, p);
  const quoteId = await insert(
    `INSERT INTO quotes (number, customer_id, status, event_date, event_time, address, district, city,
        delivery_at, pickup_at, items_cents, freight_cents, total_cents, notes, created_by, company_id, store_order_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      number, p.customer_id, "enviado", p.event_date, p.event_time ?? "", p.address ?? "", p.district ?? "", p.city ?? "",
      p.delivery_at, p.pickup_at, p.items_cents, p.freight_cents, p.total_cents,
      [p.notes ?? "", "(Solicitação da Loja Virtual)"].filter(Boolean).join(" ").slice(0, 2000),
      userId, companyId, p.id,
    ],
  );
  for (const i of preco) {
    await run(
      `INSERT INTO quote_items (quote_id, product_id, qty, unit_price_cents, discount_cents, period_qty, pricing_mode, subtotal_cents, company_id)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [quoteId, i.product_id, i.qty, i.unit_price_cents, i.discount_cents, i.period_qty, i.pricing_mode,
        subtotalItem({ qty: i.qty, unit_price_cents: i.unit_price_cents, period_qty: i.period_qty }), companyId],
    );
  }
  await run(`UPDATE store_orders SET quote_id=?, updated_at=datetime('now','localtime') WHERE id=? AND company_id=?`, [
    quoteId, orderId, companyId,
  ]);
  await registrarEvento(companyId, orderId, "orcamento", `Orçamento ${number} criado.`, `usuario:${userId ?? "sistema"}`);
  return { ok: true, quoteId };
}

export async function recusarPedido(
  companyId: number,
  orderId: number,
  userId: number | null,
  motivo: string,
): Promise<{ ok: true } | { ok: false; erro: string }> {
  const p = await pedidoDaEmpresa(companyId, orderId);
  if (!p) return { ok: false, erro: "Solicitação não encontrada." };
  if (!["aguardando_analise", "aprovada_aguardando_pagamento"].includes(p.status)) {
    return { ok: false, erro: "Esta solicitação não pode mais ser recusada." };
  }
  await run(
    `UPDATE store_orders SET status='recusada', updated_at=datetime('now','localtime') WHERE id=? AND company_id=?`,
    [orderId, companyId],
  );
  if (p.reservation_id) {
    await run(
      `UPDATE reservations SET status='cancelada', cancel_reason=?, updated_at=datetime('now','localtime')
        WHERE id=? AND company_id=? AND status IN ('pre_reserva','confirmada')`,
      [`Recusa na Loja Virtual${motivo ? `: ${motivo}` : ""}`.slice(0, 300), p.reservation_id, companyId],
    );
  }
  await registrarEvento(companyId, orderId, "recusado", motivo || "Solicitação recusada pela locadora.", `usuario:${userId ?? "sistema"}`);
  return { ok: true };
}

export async function cancelarPedido(
  companyId: number,
  orderId: number,
  userId: number | null,
  motivo: string,
): Promise<{ ok: true } | { ok: false; erro: string }> {
  const p = await pedidoDaEmpresa(companyId, orderId);
  if (!p) return { ok: false, erro: "Solicitação não encontrada." };
  await run(
    `UPDATE store_orders SET status='cancelada', updated_at=datetime('now','localtime') WHERE id=? AND company_id=?`,
    [orderId, companyId],
  );
  if (p.reservation_id) {
    await run(
      `UPDATE reservations SET status='cancelada', cancel_reason=?, updated_at=datetime('now','localtime')
        WHERE id=? AND company_id=? AND status IN ('pre_reserva','confirmada')`,
      [`Cancelamento na Loja Virtual${motivo ? `: ${motivo}` : ""}`.slice(0, 300), p.reservation_id, companyId],
    );
  }
  await registrarEvento(companyId, orderId, "cancelado", motivo || "Solicitação cancelada.", `usuario:${userId ?? "sistema"}`);
  return { ok: true };
}

/** Confirmação manual do comprovante: NUNCA automática. */
export async function definirPagamento(
  companyId: number,
  orderId: number,
  acao: "confirmar" | "recusar",
  userId: number | null,
): Promise<{ ok: true; pedido: PedidoRow } | { ok: false; erro: string }> {
  const p = await pedidoDaEmpresa(companyId, orderId);
  if (!p) return { ok: false, erro: "Solicitação não encontrada." };
  const permitido = acao === "confirmar"
    ? ["comprovante_enviado", "em_analise", "aguardando"].includes(p.payment_status)
    : ["comprovante_enviado", "em_analise"].includes(p.payment_status);
  if (!permitido) return { ok: false, erro: `Pagamento não pode ser ${acao === "confirmar" ? "confirmado" : "recusado"} neste estado.` };

  if (acao === "confirmar") {
    await run(`UPDATE store_receipts SET status='confirmado', reviewed_at=datetime('now','localtime'), reviewed_by=? WHERE store_order_id=? AND company_id=?`, [userId, orderId, companyId]);
    const novos = p.status === "aprovada_aguardando_pagamento" ? "confirmada" : p.status;
    await run(
      `UPDATE store_orders SET payment_status='confirmado', status=?, updated_at=datetime('now','localtime') WHERE id=? AND company_id=?`,
      [novos, orderId, companyId],
    );
    if (p.reservation_id && p.status === "aprovada_aguardando_pagamento") {
      await run(`UPDATE reservations SET status='confirmada', updated_at=datetime('now','localtime') WHERE id=? AND company_id=?`, [p.reservation_id, companyId]);
      await recalcReservation(p.reservation_id);
      await emailConfirmacao(companyId, p.reservation_id);
    }
    await registrarEvento(companyId, orderId, "pagamento_confirmado", "Pagamento confirmado pela locadora.", `usuario:${userId ?? "sistema"}`);
  } else {
    await run(`UPDATE store_receipts SET status='recusado', reviewed_at=datetime('now','localtime'), reviewed_by=? WHERE store_order_id=? AND company_id=?`, [userId, orderId, companyId]);
    await run(
      `UPDATE store_orders SET payment_status='recusado', updated_at=datetime('now','localtime') WHERE id=? AND company_id=?`,
      [orderId, companyId],
    );
    await registrarEvento(companyId, orderId, "pagamento_recusado", "Comprovante recusado/não identificado.", `usuario:${userId ?? "sistema"}`);
  }
  const depois = await pedidoDaEmpresa(companyId, orderId);
  return { ok: true, pedido: depois! };
}

function agoraMaisHoras(horas: number): string {
  const h = Math.max(1, Math.floor(horas));
  return new Date(Date.now() + h * 3600_000).toISOString().slice(0, 16);
}

/** Mesmo gatilho de e-mail do painel (fail-open, dedupe por estado). */
async function emailConfirmacao(companyId: number, reservationId: number): Promise<void> {
  try {
    const { reservaCriada } = await import("./email-gatilhos");
    await reservaCriada(companyId, reservationId, "confirmada");
  } catch (e) {
    console.error("[loja] gatilho de e-mail falhou (fail-open):", (e as Error)?.message);
  }
}

/* ------------------------------------------------------------------ */
/* Notificação interna da equipe                                       */
/* ------------------------------------------------------------------ */

/**
 * Avisa a equipe (owner/admin ativos) na central de notificações. Usa o tipo
 * `reserva` — a mesma regra de push que a empresa já tem configurada — para
 * não criar um tipo de notificação sem regra no painel de preferências.
 */
export async function notificarEquipe(companyId: number, titulo: string, corpo: string, link: string): Promise<void> {
  try {
    const destinos = await all<{ id: number }>(
      `SELECT id FROM users WHERE company_id = ? AND active = 1 AND role IN ('owner','admin')`,
      [companyId],
    );
    for (const d of destinos) {
      await run(
        `INSERT INTO user_notifications (user_id, event_id, type, title, body, link, created_at, company_id)
         VALUES (?, NULL, 'reserva', ?, ?, ?, unixepoch(), ?)
         ON CONFLICT(user_id, event_id) DO NOTHING`,
        [d.id, titulo.slice(0, 140), corpo.slice(0, 200), link, companyId],
      );
      await run(
        `INSERT OR IGNORE INTO push_deliveries (company_id, notification_id, subscription_id)
         SELECT n.company_id, n.id, s.id
           FROM user_notifications n
           JOIN push_subscriptions s ON s.user_id = n.user_id AND s.company_id = n.company_id
          WHERE n.id = (SELECT MAX(id) FROM user_notifications WHERE user_id = ? AND type = 'reserva' AND link = ?)
            AND s.enabled = 1
            AND (s.expiration_time IS NULL OR s.expiration_time > ?)`,
        [d.id, link, Date.now()],
      );
    }
  } catch (e) {
    console.error("[loja] notificação interna falhou (fail-open):", (e as Error)?.message);
  }
}

/* ------------------------------------------------------------------ */
/* Settings auxiliares                                                 */
/* ------------------------------------------------------------------ */

/** Configurações da empresa usadas pela loja (frete, preços, operação). */
export async function settingsDaLoja(companyId: number): Promise<Settings> {
  return await settingsDaEmpresa(companyId);
}

/** Janela padrão do pedido quando a empresa não trabalha com horários. */
export function janelaPadrao(eventDate: string, eventTime?: string | null): { delivery_at: string; pickup_at: string } {
  const hora = (eventTime || "08:00").slice(0, 5) || "08:00";
  return {
    delivery_at: `${eventDate}T${hora}`,
    pickup_at: `${addDays(eventDate, 1)}T18:00`,
  };
}

/** Reexporta helpers de janela usados pelas telas. */
export { holdWindow, explodeLine, isKit, today };
