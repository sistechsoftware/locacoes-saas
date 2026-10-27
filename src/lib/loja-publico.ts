import "server-only";
/**
 * Loja Virtual — camada PÚBLICA (sem sessão de funcionário).
 *
 * Barreiras que toda função deste módulo aplica, nesta ordem:
 *  1. slug existe, loja PUBLICADA, empresa ativa e recurso `loja_virtual`
 *     liberado para ESTA empresa (plano Empresarial ou exceção administrativa
 *     — mesma precedência central do painel; revogar bloqueia aqui);
 *  2. todo dado lido/escrito sai com WHERE company_id = ? derivado do slug
 *     gravado no banco — nenhum identificador do navegador prova dono;
 *  3. preços, períodos, frete e disponibilidade são SEMPRE recalculados no
 *     servidor na submissão: o que o navegador manda serve só para achar os
 *     produtos, nunca para fixar valor;
 *  4. token de acompanhamento: 24 bytes aleatórios, o banco guarda só o
 *     SHA-256 — sem enumeração de pedidos pelo número sequencial.
 */
import crypto from "node:crypto";
import { all, insert, isUniqueViolation, one, run, scalar } from "./db";
import type { LojaRow, PedidoRow } from "./loja-db";
import { lojaDaEmpresa, notificarEquipe, registrarEvento, expirarPedidos, janelaPadrao } from "./loja-db";
import { recursoLiberado } from "./plano-personalizado";
import { aplicarPrecos } from "./pricing";
import { checkConflicts, conflictsMessage } from "./stock";
import { windowError } from "./availability-time";
import { subtotalItem, totaisPedido, validarDataPedido, comprovanteAceito, pixCopiaECola } from "./loja";
import { freightConfig } from "./freight-config";
import { calculateRoadRoute, RouteError } from "./routes";
import { openMapServices } from "./map-services";
import { onlyDigits, today } from "./format";
import { cpfValido } from "./portal-core";
import { settingsDaEmpresa } from "./settings";

/* ------------------------------------------------------------------ */
/* Resolução da loja                                                   */
/* ------------------------------------------------------------------ */

export type ResultadoLoja = { ok: true; loja: LojaRow; nomeEmpresa: string } | { ok: false; status: number; erro: string };

/**
 * Resolve o slug público. `requerPublicada=false` serve o acompanhamento de
 * pedidos já existentes mesmo com a loja tirada do ar (tratamento adequado de
 * solicitações anteriores — a revogação corta NOVAS operações públicas).
 */
export async function lojaPorSlug(slug: string, opts: { requerPublicada?: boolean } = {}): Promise<ResultadoLoja> {
  const requerPublicada = opts.requerPublicada !== false;
  if (typeof slug !== "string" || slug.length > 80) return { ok: false, status: 404, erro: "Loja não encontrada." };
  const loja = await one<LojaRow>(`SELECT * FROM company_stores WHERE slug = ?`, [slug]);
  if (!loja) return { ok: false, status: 404, erro: "Loja não encontrada." };

  const empresa = await one<{ name: string; active: number }>(`SELECT name, active FROM companies WHERE id = ?`, [loja.company_id]);
  if (!empresa || empresa.active !== 1) return { ok: false, status: 404, erro: "Loja não encontrada." };

  // Recurso por PLANO/EXCEÇÃO: fail-closed (falha de leitura bloqueia).
  try {
    if (!(await recursoLiberado(loja.company_id, "loja_virtual"))) {
      return { ok: false, status: 404, erro: "Loja não encontrada." };
    }
  } catch {
    return { ok: false, status: 404, erro: "Loja indisponível no momento." };
  }

  if (requerPublicada && loja.status !== "publicada") {
    return { ok: false, status: 404, erro: "Loja não encontrada." };
  }
  return { ok: true, loja, nomeEmpresa: empresa.name };
}

/* ------------------------------------------------------------------ */
/* Catálogo                                                            */
/* ------------------------------------------------------------------ */

export type ItemCatalogo = {
  product_id: number;
  name: string;
  kind: string;
  photo: string | null;
  photo_loja: string | null;
  category: string | null;
  description: string | null;
  public_description: string | null;
  preco_cents: number;
  pricing_mode: string | null;
  featured: number;
  sort_order: number;
  max_qty: number | null;
};

export type CategoriaLoja = { id: number; name: string; itens: ItemCatalogo[] };

export async function catalogoDaLoja(loja: LojaRow): Promise<ItemCatalogo[]> {
  const rows = await all<any>(
    `    SELECT p.id AS product_id, p.name, p.kind, p.photo, p.description, p.pricing_mode, p.rent_price_cents,
            sp.public_price_cents, sp.public_name, sp.public_description, sp.photo_url,
            sp.featured, sp.sort_order, sp.max_qty, c.id AS category_id, c.name AS category
       FROM store_products sp
       JOIN products p ON p.id = sp.product_id AND p.company_id = sp.company_id
       LEFT JOIN categories c ON c.id = p.category_id AND c.company_id = sp.company_id
      WHERE sp.company_id = ? AND sp.published = 1 AND p.active = 1 AND p.is_demo = 0
      ORDER BY sp.featured DESC, sp.sort_order ASC, p.name ASC`,
    [loja.company_id],
  );
  return rows.map((r) => ({
    product_id: r.product_id,
    name: (r.public_name || r.name || "").trim(),
    kind: r.kind,
    photo: r.photo ?? null,
    photo_loja: r.photo_url ?? null,
    category: r.category ?? null,
    description: r.public_description || r.description || null,
    public_description: r.public_description ?? null,
    preco_cents: Number(r.public_price_cents ?? r.rent_price_cents ?? 0),
    pricing_mode: r.pricing_mode ?? null,
    featured: Number(r.featured ?? 0),
    sort_order: Number(r.sort_order ?? 0),
    max_qty: r.max_qty ?? null,
  }));
}

/** Agrupa por categoria preservando a ordem; sem categoria vai para "Geral". */
export async function catalogoPorCategoria(loja: LojaRow): Promise<CategoriaLoja[]> {
  const itens = await catalogoDaLoja(loja);
  const mapa = new Map<string, CategoriaLoja>();
  for (const i of itens) {
    const chave = i.category ?? "";
    const rotulo = i.category || "Geral";
    const atual = mapa.get(chave) ?? { id: chave === "" ? 0 : Math.abs(hashNum(chave)), name: rotulo, itens: [] };
    atual.itens.push(i);
    mapa.set(chave, atual);
  }
  return [...mapa.values()];
}

function hashNum(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** Item único (página de detalhe), restrito ao que está publicado. */
export async function produtoPublicado(loja: LojaRow, productId: number): Promise<ItemCatalogo | null> {
  const itens = await catalogoDaLoja(loja);
  return itens.find((i) => i.product_id === productId) ?? null;
}

/* ------------------------------------------------------------------ */
/* Dados públicos da loja (identidade + regras resumidas)              */
/* ------------------------------------------------------------------ */

export type VisaoLoja = {
  loja: LojaRow;
  nomeEmpresa: string;
  itens: number;
  aceitaOrcamento: boolean;
  aceitaReserva: boolean;
};

export async function visaoDaLoja(slug: string): Promise<ResultadoLoja & { visao?: VisaoLoja }> {
  const base = await lojaPorSlug(slug);
  if (!base.ok) return base;
  const { loja, nomeEmpresa } = base;
  const itens = await scalar<number>(
    `SELECT COUNT(*) FROM store_products sp JOIN products p ON p.id = sp.product_id AND p.company_id = sp.company_id
      WHERE sp.company_id = ? AND sp.published = 1 AND p.active = 1`,
    [loja.company_id],
  );
  return {
    ok: true,
    loja,
    nomeEmpresa,
    visao: {
      loja,
      nomeEmpresa,
      itens: Number(itens || 0),
      aceitaOrcamento: true,
      aceitaReserva: loja.mode !== "orcamento",
    },
  };
}

/* ------------------------------------------------------------------ */
/* Frete (mesma fórmula e mesmo endereço-base do painel)               */
/* ------------------------------------------------------------------ */

/**
 * URLs dos serviços de mapa, do MESMO ambiente que o resto do sistema usa
 * (vars do Worker, com fallback para process.env fora do Workers). A rota
 * /api/routes resolve pelo contexto do Cloudflare; aqui a leitura é
 * lazy para não quebrar testes/rotinas sem contexto.
 */
async function urlsDeMapa(): Promise<[string, string]> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = getCloudflareContext().env as unknown as Record<string, string | undefined>;
    if (env.NOMINATIM_URL && env.OSRM_URL) return [env.NOMINATIM_URL, env.OSRM_URL];
  } catch {
    /* fora do Workers: cai para process.env / padrões */
  }
  return [
    process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org/",
    process.env.OSRM_URL || "https://routing.openstreetmap.de/routed-car",
  ];
}

export type ResultadoFreteLoja =
  | { ok: true; valor_cents: number; km: number; status: "calculado" }
  | { ok: false; status: "pendente" | "isento"; aviso: string };

/**
 * Calcula o frete da entrega pelo mecanismo existente: configuração da
 * empresa (freight_*), endereço-base da empresa, rota rodoviária real com
 * cache em route_cache. Falha do serviço nunca vira frete "confirmado":
 * devolve pendente (se a empresa permite) ou erro claro.
 */
export async function calcularFreteLoja(loja: LojaRow, endereco: { address: string; city: string; district?: string; zip?: string }): Promise<ResultadoFreteLoja> {
  const settings = await settingsDaEmpresa(loja.company_id);
  const cfg = freightConfig(settings, loja.freight_type);
  const completo = [endereco.address, endereco.district, endereco.city].filter(Boolean).join(", ");
  if (completo.trim().length < 10) {
    return { ok: false, status: "pendente", aviso: "Informe rua, número e cidade para estimarmos o frete." };
  }
  try {
    const services = openMapServices(...(await urlsDeMapa()));
    const rota = await calculateRoadRoute(loja.freight_type, cfg, completo, completo, services);
    return { ok: true, valor_cents: rota.suggestedCents, km: rota.totalKm, status: "calculado" };
  } catch (e) {
    if (e instanceof RouteError) {
      if (loja.freight_pending_ok) {
        return { ok: false, status: "pendente", aviso: `${e.message} O frete será confirmado pela locadora.` };
      }
      return { ok: false, status: "pendente", aviso: e.message };
    }
    if (loja.freight_pending_ok) {
      return { ok: false, status: "pendente", aviso: "Não foi possível calcular o frete agora; ele será confirmado pela locadora." };
    }
    return { ok: false, status: "pendente", aviso: "Não foi possível calcular o frete. Tente novamente ou fale com a locadora." };
  }
}

/* ------------------------------------------------------------------ */
/* Cliente (cadastro existente, sem duplicidade indevida)              */
/* ------------------------------------------------------------------ */

const norm = (col: string) =>
  `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(LOWER(COALESCE(${col},'')),'.',''),'-',''),' ',''),'(',''),')',''),'/','')`;

async function localizarOuCriarCliente(
  companyId: number,
  dados: { nome: string; telefone: string; email: string; doc: string },
): Promise<number> {
  const doc = onlyDigits(dados.doc);
  const tel = onlyDigits(dados.telefone);
  const candidatos = await all<any>(
    `SELECT id, name, phone, whatsapp, email, doc FROM customers
      WHERE company_id = ? AND active = 1
        AND ((${norm("doc")} = ?) OR (${norm("phone")} LIKE ?) OR (${norm("whatsapp")} LIKE ?))
      LIMIT 5`,
    [companyId, doc || "#sem-documento#", `%${tel}`, `%${tel}`],
  );

  let cliente =
    (doc.length >= 11 && candidatos.find((c) => onlyDigits(c.doc) === doc)) ||
    (tel.length >= 10 && candidatos.find((c) => {
      const p = onlyDigits(c.phone);
      const w = onlyDigits(c.whatsapp);
      return (p && p.endsWith(tel.slice(-11))) || (w && w.endsWith(tel.slice(-11)));
    }));

  if (cliente) {
    // Preenche só o que faltava: um formulário público nunca sobrescreve o
    // cadastro que a equipe já tem.
    const sets: string[] = [];
    const vals: any[] = [];
    if (!cliente.email && dados.email) { sets.push("email=?"); vals.push(dados.email); }
    if (!cliente.phone && tel) { sets.push("phone=?"); vals.push(dados.telefone); }
    if (!cliente.doc && doc) { sets.push("doc=?"); vals.push(dados.doc); }
    if (sets.length) {
      await run(`UPDATE customers SET ${sets.join(",")}, updated_at=datetime('now','localtime') WHERE id=? AND company_id=?`, [
        ...vals,
        cliente.id,
        companyId,
      ]);
    }
    return cliente.id;
  }

  return await insert(
    `INSERT INTO customers (name, doc, phone, whatsapp, email, company_id) VALUES (?,?,?,?,?,?)`,
    [dados.nome.slice(0, 120), dados.doc || null, dados.telefone || null, dados.telefone || null, dados.email || null, companyId],
  );
}

/* ------------------------------------------------------------------ */
/* Token de acompanhamento                                             */
/* ------------------------------------------------------------------ */

export function novoTokenAcompanhamento(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function hashAcompanhamento(token: string): string {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

/* ------------------------------------------------------------------ */
/* Submissão de pedido                                                 */
/* ------------------------------------------------------------------ */

export type PedidoInput = {
  slug: string;
  itens: { product_id: number; qty: number }[];
  cliente: { nome: string; telefone: string; email?: string; doc?: string };
  event_date: string;
  event_time?: string;
  modalidade: "entrega" | "retirada";
  endereco?: { address: string; district?: string; city?: string; zip?: string };
  observacoes?: string;
  aceitou_termos?: boolean;
  /** Frete já calculado pelo cliente (o servidor recalcula na mesma hora). */
  frete_calculado?: number;
};

export type PedidoCriado = {
  ok: true;
  token: string;
  number: string;
  kind: "orcamento" | "reserva";
  status: string;
  payment_status: string;
  totals: { items_cents: number; freight_cents: number; total_cents: number; signal_cents: number };
  frete_aviso: string | null;
  mensagem: string;
  pix: { key: string; holder: string; city: string; instructions: string; payload: string | null } | null;
  payment_deadline_at: string | null;
};

export type ErroPedido = { ok: false; erro: string };

/**
 * Cria a solicitação. Sempre: valida → resolve produtos/preços no servidor →
 * cliente → frete → totais → grava pedido → (modo automático) tenta reserva
 * com CAS → notifica a equipe. Devolve o token de acompanhamento uma única vez.
 */
export async function criarPedidoPublico(input: PedidoInput, meta: { ip?: string } = {}): Promise<PedidoCriado | ErroPedido> {
  const res = await lojaPorSlug(input.slug);
  if (!res.ok) return { ok: false, erro: res.erro };
  const { loja } = res;

  if (loja.paused) {
    return { ok: false, erro: loja.pause_message?.trim() || "A loja não está recebendo novas solicitações no momento." };
  }

  /* ---- itens: só product_id/qty do navegador; preço vem do banco ---- */
  const bruto = Array.isArray(input.itens) ? input.itens : [];
  const linhas = bruto
    .map((i) => ({ product_id: Number(i?.product_id), qty: Math.floor(Number(i?.qty)) }))
    .filter((i) => i.product_id > 0 && i.qty > 0);
  if (!linhas.length) return { ok: false, erro: "Adicione ao menos um produto à solicitação." };
  if (linhas.length > 50) return { ok: false, erro: "Solicitação com itens demais. Divida em pedidos menores." };
  for (const l of linhas) {
    if (l.qty > 999) return { ok: false, erro: "Quantidade por item inválida." };
  }

  const publicados = await catalogoDaLoja(loja);
  const porId = new Map(publicados.map((p) => [p.product_id, p]));
  const faltantes: string[] = [];
  const itens: { product_id: number; qty: number; unit_price_cents: number; item: ItemCatalogo }[] = [];
  for (const l of linhas) {
    const p = porId.get(l.product_id);
    if (!p) { faltantes.push(String(l.product_id)); continue; }
    if (p.max_qty && l.qty > p.max_qty) {
      return { ok: false, erro: `Quantidade máxima de "${p.name}" é ${p.max_qty}.` };
    }
    if (loja.hide_prices && !(p.pricing_mode === "sob_consulta")) {
      // preço oculto: pedido segue como orçamento com valor zero exibido?
      // Não — sem preço exibido o total não pode ser afirmado; marcamos 0 e o
      // painel reprica na análise (o pedido continua legítimo).
    }
    itens.push({ product_id: l.product_id, qty: l.qty, unit_price_cents: Math.max(0, p.preco_cents), item: p });
  }
  if (faltantes.length) {
    return { ok: false, erro: "Alguns itens não estão mais disponíveis na loja. Atualize a página e tente novamente." };
  }

  /* ---- cliente ---- */
  const nome = String(input.cliente?.nome ?? "").trim().slice(0, 120);
  const telefone = String(input.cliente?.telefone ?? "").trim().slice(0, 40);
  const email = String(input.cliente?.email ?? "").trim().slice(0, 120);
  const doc = String(input.cliente?.doc ?? "").trim().slice(0, 20);
  if (nome.length < 3) return { ok: false, erro: "Informe seu nome completo." };
  if (onlyDigits(telefone).length < 10) return { ok: false, erro: "Informe um telefone válido com DDD." };
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, erro: "E-mail inválido." };
  const docDigits = onlyDigits(doc);
  if (docDigits.length && docDigits.length !== 11) return { ok: false, erro: "CPF deve ter 11 dígitos." };
  if (docDigits.length === 11 && !cpfValido(docDigits)) return { ok: false, erro: "CPF inválido." };

  /* ---- data e janela ---- */
  const eventDate = String(input.event_date ?? "").slice(0, 10);
  const erroData = validarDataPedido(loja, today(), eventDate);
  if (erroData) return { ok: false, erro: erroData };
  const eventTime = String(input.event_time ?? "").trim().slice(0, 5);
  const janela = janelaPadrao(eventDate, eventTime);
  const erroJanela = windowError(janela.delivery_at, janela.pickup_at);
  if (erroJanela) return { ok: false, erro: erroJanela };

  /* ---- modalidade e frete ---- */
  const modalidade: "entrega" | "retirada" = input.modalidade === "retirada" ? "retirada" : "entrega";
  if (modalidade === "entrega" && !loja.offer_delivery) return { ok: false, erro: "Esta loja não entrega no endereço informado." };
  if (modalidade === "retirada" && !loja.offer_pickup) return { ok: false, erro: "Esta loja não oferece retirada." };

  let freight_cents = 0;
  let freight_status: "nao_calculado" | "calculado" | "pendente" | "isento" = "isento";
  let frete_aviso: string | null = null;
  let enderecoGravado = { address: "", district: "", city: "", zip: "" };
  if (modalidade === "entrega") {
    const end = {
      address: String(input.endereco?.address ?? "").trim().slice(0, 200),
      district: String(input.endereco?.district ?? "").trim().slice(0, 80),
      city: String(input.endereco?.city ?? "").trim().slice(0, 80),
      zip: String(input.endereco?.zip ?? "").trim().slice(0, 12),
    };
    if (end.address.length < 5 || end.city.length < 2) {
      return { ok: false, erro: "Informe rua, número e cidade da entrega." };
    }
    const frete = await calcularFreteLoja(loja, end);
    if (frete.ok) {
      freight_cents = frete.valor_cents;
      freight_status = "calculado";
    } else if (loja.freight_pending_ok) {
      freight_status = "pendente";
      frete_aviso = frete.aviso;
    } else {
      return { ok: false, erro: frete.aviso };
    }
    enderecoGravado = end;
  } else {
    enderecoGravado = { address: "", district: "", city: "", zip: "" };
    freight_status = "isento";
  }

  /* ---- termos e valor mínimo ---- */
  if (loja.require_terms && !input.aceitou_termos) {
    return { ok: false, erro: "É necessário aceitar os termos para continuar." };
  }

  /* ---- preços e período: resolvidos no SERVIDOR ---- */
  const precos = await aplicarPrecos(
    itens.map((i) => ({ product_id: i.product_id, qty: i.qty, unit_price_cents: i.unit_price_cents })),
    { delivery_at: janela.delivery_at, pickup_at: janela.pickup_at },
    loja.company_id,
  );
  const totais = totaisPedido(precos, { freightCents: freight_cents, signalPercent: loja.signal_percent });
  if (loja.min_order_cents > 0 && totais.total_cents < loja.min_order_cents) {
    return { ok: false, erro: `O pedido mínimo desta loja é de R$ ${(loja.min_order_cents / 100).toFixed(2)}.` };
  }

  /* ---- gravação ---- */
  const customerId = await localizarOuCriarCliente(loja.company_id, { nome, telefone, email, doc: docDigits });
  const token = novoTokenAcompanhamento();
  const kind: "orcamento" | "reserva" = loja.mode === "orcamento" ? "orcamento" : "reserva";

  // Número sequencial por empresa: em corrida, o UNIQUE(company_id, number)
  // recusa a duplicata e o retry recalcula — o banco é quem garante.
  let number = "";
  let orderId = 0;
  for (let tentativa = 0; tentativa < 4 && !orderId; tentativa++) {
    number = await nextStoreNumber(loja.company_id);
    try {
      orderId = await insert(
    `INSERT INTO store_orders (company_id, number, tracking_hash, kind, status, payment_status,
        customer_id, customer_name, customer_phone, customer_email, customer_doc,
        event_date, event_time, delivery_at, pickup_at, needs_delivery,
        address, district, city, zip, notes,
        freight_cents, freight_status, items_cents, total_cents, signal_cents, terms_accepted)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      loja.company_id, number, hashAcompanhamento(token), kind, "aguardando_analise", "nao_informado",
      customerId, nome, telefone, email, docDigits || null,
      eventDate, eventTime || null, janela.delivery_at, janela.pickup_at, modalidade === "entrega" ? 1 : 0,
      enderecoGravado.address || null, enderecoGravado.district || null, enderecoGravado.city || null,
      enderecoGravado.zip || null, String(input.observacoes ?? "").trim().slice(0, 1000) || null,
      freight_cents, freight_status, totais.items_cents, totais.total_cents, totais.signal_cents,
      input.aceitou_termos ? 1 : 0,
      ],
      );
    } catch (e) {
      if (!isUniqueViolation(e) || tentativa === 3) throw e;
    }
  }
  if (!orderId) return { ok: false, erro: "Não foi possível registrar o pedido. Tente novamente." };

  for (const i of precos) {
    const src = itens.find((x) => x.product_id === i.product_id)!;
    await run(
      `INSERT INTO store_order_items (store_order_id, company_id, product_id, name, qty, unit_price_cents, period_qty, pricing_mode, subtotal_cents)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        orderId, loja.company_id, i.product_id, src.item.name.slice(0, 120), i.qty,
        i.unit_price_cents, i.period_qty, i.pricing_mode,
        subtotalItem({ qty: i.qty, unit_price_cents: i.unit_price_cents, period_qty: i.period_qty }),
      ],
    );
  }

  await registrarEvento(loja.company_id, orderId, "criado", `Solicitação enviada pela Loja Virtual (${kind}).`, "cliente");
  if (frete_aviso) {
    await registrarEvento(loja.company_id, orderId, "frete_pendente", frete_aviso, "sistema");
  }

  /* ---- modo automático: só aprova se TODAS as condições passarem ---- */
  let status = "aguardando_analise";
  let payment_status = "nao_informado";
  let payment_deadline_at: string | null = null;
  if (loja.mode === "automatica") {
    const conflitos = await checkConflicts(
      precos.map((i) => ({ product_id: i.product_id, qty: i.qty })),
      janela.delivery_at,
      janela.pickup_at,
      null,
      {},
      loja.company_id,
    );
    const freteOk = modalidade === "retirada" || freight_status === "calculado" || loja.freight_pending_ok === 1;
    const dadosOk = !loja.require_terms || !!input.aceitou_termos;
    if (!conflitos.length && freteOk && dadosOk) {
      const { aprovarPedido } = await import("./loja-db");
      const r = await aprovarPedido(loja.company_id, orderId, null);
      if (r.ok) {
        status = r.pedido.status;
        payment_status = r.pedido.payment_status;
        payment_deadline_at = r.pedido.payment_deadline_at;
      } else {
        // condição não puder ser validada → análise manual, como manda a regra
        await registrarEvento(loja.company_id, orderId, "auto_pendente", `Aprovação automática não concluiu: ${r.erro}`, "sistema");
      }
    } else {
      const motivo = conflitos.length ? conflictsMessage(conflitos) : "Pendência de frete/dados";
      await registrarEvento(loja.company_id, orderId, "auto_pendente", `Aprovação automática adiada para análise: ${motivo}`, "sistema");
    }
  }

  /* ---- notificação da equipe (fail-open) ---- */
  await notificarEquipe(
    loja.company_id,
    `Nova solicitação na Loja Virtual: ${number}`,
    `${nome} pediu ${itens.length} item(ns) para ${formatarData(eventDate)} — R$ ${(totais.total_cents / 100).toFixed(2)}`,
    `/configuracoes/loja/pedidos/${orderId}`,
  );

  /* ---- Pix da empresa, se habilitado ---- */
  const pix = await dadosPix(loja, totais.total_cents, number);

  return {
    ok: true,
    token,
    number,
    kind,
    status,
    payment_status,
    totals: totais,
    frete_aviso,
    mensagem: loja.success_message?.trim() || "Solicitação enviada! A locadora vai analisar e responder em breve.",
    pix,
    payment_deadline_at,
  };
}

function formatarData(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function nextStoreNumber(companyId: number): Promise<string> {
  const row = await one<{ n: string }>(
    `SELECT number AS n FROM store_orders WHERE company_id = ? AND number LIKE 'LOJA-%'
      ORDER BY LENGTH(number) DESC, number DESC LIMIT 1`,
    [companyId],
  );
  const last = row ? parseInt(row.n.split("-").pop() ?? "0", 10) || 0 : 0;
  return `LOJA-${String(last + 1).padStart(3, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Pix                                                                 */
/* ------------------------------------------------------------------ */

export async function dadosPix(
  loja: LojaRow,
  valorCents: number,
  identificador: string,
): Promise<PedidoCriado["pix"]> {
  if (!loja.pix_enabled || !loja.pix_key.trim()) return null;
  const r = pixCopiaECola({
    chave: loja.pix_key,
    nome: loja.pix_holder || loja.display_name,
    cidade: loja.pix_city || loja.city,
    valorCents,
    identificador: identificador.replace(/[^A-Za-z0-9]/g, ""),
  });
  return {
    key: loja.pix_key,
    holder: loja.pix_holder,
    city: loja.pix_city,
    instructions: loja.pix_instructions,
    payload: r.ok ? r.payload : null,
  };
}

/* ------------------------------------------------------------------ */
/* Acompanhamento                                                      */
/* ------------------------------------------------------------------ */

export type Acompanhamento = {
  number: string;
  status: string;
  payment_status: string;
  kind: string;
  event_date: string;
  itens: { name: string; qty: number; unit_price_cents: number; subtotal_cents: number }[];
  totals: { items_cents: number; freight_cents: number; total_cents: number; signal_cents: number };
  freight_status: string;
  payment_deadline_at: string | null;
  comprovante: { status: string; submitted_at: string } | null;
  prazoExpirado: boolean;
};

/**
 * Acesso público ao pedido SEM conta: token de 24 bytes (só hash no banco).
 * Devolve o mínimo necessário — sem dados internos, sem PII de terceiros, sem
 * identificadores de outras tabelas.
 */
export async function acompanhamentoPorToken(
  slug: string,
  token: string,
): Promise<{ ok: true; pedido: Acompanhamento; loja: LojaRow } | { ok: false; erro: string }> {
  const res = await lojaPorSlug(slug, { requerPublicada: false });
  if (!res.ok) return { ok: false, erro: "Loja não encontrada." };
  const { loja } = res;
  if (typeof token !== "string" || token.length < 16 || token.length > 128) return { ok: false, erro: "Link inválido." };

  await expirarPedidos(loja.company_id);
  const p = await one<PedidoRow>(`SELECT * FROM store_orders WHERE tracking_hash = ? AND company_id = ?`, [
    hashAcompanhamento(token),
    loja.company_id,
  ]);
  if (!p) return { ok: false, erro: "Pedido não encontrado ou link expirado." };

  const itens = await all<any>(
    `SELECT name, qty, unit_price_cents, subtotal_cents FROM store_order_items WHERE store_order_id = ? AND company_id = ? ORDER BY id`,
    [p.id, loja.company_id],
  );
  const rec = await one<any>(
    `SELECT status, submitted_at FROM store_receipts WHERE store_order_id = ? AND company_id = ? ORDER BY id DESC LIMIT 1`,
    [p.id, loja.company_id],
  );

  return {
    ok: true,
    loja,
    pedido: {
      number: p.number,
      status: p.status,
      payment_status: p.payment_status,
      kind: p.kind,
      event_date: p.event_date,
      itens: itens.map((i) => ({
        name: i.name,
        qty: i.qty,
        unit_price_cents: i.unit_price_cents,
        subtotal_cents: i.subtotal_cents,
      })),
      totals: {
        items_cents: p.items_cents,
        freight_cents: p.freight_cents,
        total_cents: p.total_cents,
        signal_cents: p.signal_cents,
      },
      freight_status: p.freight_status,
      payment_deadline_at: p.payment_deadline_at,
      comprovante: rec ? { status: rec.status, submitted_at: rec.submitted_at } : null,
      prazoExpirado: p.status === "expirada",
    },
  };
}

/* ------------------------------------------------------------------ */
/* Comprovante                                                         */
/* ------------------------------------------------------------------ */

export type ResultadoComprovante = { ok: true; status: string } | { ok: false; erro: string };

/**
 * Envia o comprovante: valida tipo/tamanho, grava em `files` (escopo da
 * empresa) e liga ao pedido pelo token. Enviar NUNCA confirma pagamento —
 * o estado vira `comprovante_enviado` e a locadora decide.
 */
export async function enviarComprovante(
  slug: string,
  token: string,
  file: File | null,
): Promise<ResultadoComprovante> {
  const res = await lojaPorSlug(slug, { requerPublicada: false });
  if (!res.ok) return { ok: false, erro: "Loja não encontrada." };
  const { loja } = res;
  if (typeof token !== "string" || token.length < 16 || token.length > 128) return { ok: false, erro: "Link inválido." };

  const p = await one<PedidoRow>(`SELECT * FROM store_orders WHERE tracking_hash = ? AND company_id = ?`, [
    hashAcompanhamento(token),
    loja.company_id,
  ]);
  if (!p) return { ok: false, erro: "Pedido não encontrado ou link expirado." };
  if (!["aprovada_aguardando_pagamento", "confirmada", "aguardando_analise"].includes(p.status)) {
    return { ok: false, erro: "Este pedido não está mais aberto para envio de comprovante." };
  }
  if (!file || typeof file === "string" || file.size === 0) return { ok: false, erro: "Selecione o arquivo do comprovante." };

  const erro = comprovanteAceito(file.type, file.size);
  if (erro) return { ok: false, erro };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileId = crypto.randomBytes(16).toString("hex");
  const { getDb } = await import("./db");
  await getDb()
    .prepare(`INSERT INTO files (id, mime, size, data, company_id) VALUES (?,?,?,?,?)`)
    .bind(fileId, file.type, bytes.length, bytes, loja.company_id)
    .run();

  await run(
    `INSERT INTO store_receipts (store_order_id, company_id, file_id, mime, size) VALUES (?,?,?,?,?)`,
    [p.id, loja.company_id, fileId, file.type, bytes.length],
  );
  await run(
    `UPDATE store_orders SET payment_status='comprovante_enviado', updated_at=datetime('now','localtime')
      WHERE id = ? AND company_id = ? AND payment_status IN ('nao_informado','aguardando','recusado','expirado')`,
    [p.id, loja.company_id],
  );
  await registrarEvento(loja.company_id, p.id, "comprovante", "Comprovante de pagamento enviado (aguardando verificação).", "cliente");
  await notificarEquipe(
    loja.company_id,
    `Comprovante recebido: ${p.number}`,
    `${p.customer_name} enviou um comprovante para verificação.`,
    `/configuracoes/loja/pedidos/${p.id}`,
  );
  return { ok: true, status: "comprovante_enviado" };
}

/* ------------------------------------------------------------------ */
/* Disponibilidade (prévia para o cliente)                             */
/* ------------------------------------------------------------------ */

export type DisponibilidadeItem = { product_id: number; available: number; total: number };

/**
 * Disponibilidade dos itens do carrinho na data escolhida — LEITURA
 * informativa; a garantia é revalidada na submissão e na aprovação.
 */
export async function disponibilidadeDaJanela(
  loja: LojaRow,
  productIds: number[],
  deliveryAt: string,
  pickupAt: string,
): Promise<DisponibilidadeItem[]> {
  if (!productIds.length) return [];
  const { availabilityFor } = await import("./stock");
  const out: DisponibilidadeItem[] = [];
  for (const id of productIds.slice(0, 30)) {
    try {
      const a = await availabilityFor(id, deliveryAt, pickupAt, null, {}, loja.company_id);
      out.push({ product_id: id, available: a.available, total: a.total });
    } catch {
      // produto sumiu do cadastro: o cliente vê "indisponível" na submissão
    }
  }
  return out;
}

/** Exportado para as telas calcularem o total com a mesma regra do servidor. */
export { janelaPadrao };
