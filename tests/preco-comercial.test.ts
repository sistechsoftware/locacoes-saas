/**
 * PREÇO COMERCIAL DE RESERVA E ORÇAMENTO — preservação do valor gravado.
 *
 * O defeito: o preço era recalculado pela promoção vigente toda vez que o
 * registro era reaberto e salvo (editor + actions de edição), e a marca de
 * "preço digitado a mão" nem era persistida. Resultado: o valor negociado com
 * o cliente desaparecia, e uma promoção nova ou alterada reescrevia o passado.
 *
 * A correção tem duas metades, provadas aqui com SQLite e migrations reais:
 *   - cada linha grava a ORIGEM do preço (normal/promocao/manual) e a auditoria
 *     (preço de catálogo, preço promocional calculado, promoção aplicada);
 *   - a EDIÇÃO nunca reprecifica linha existente: promoção só entra em produto
 *     novo ou quando o operador aplica explicitamente.
 *
 * Cenários 1 a 10 do relatório de auditoria, mais os casos de legado e de
 * linha nova durante a edição.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* Scaffold do Next: as actions importam next/*, que exige o runtime. */
const SESSAO = "sess-preco-comercial";
const carregarOriginal = (Module as any)._load;

(Module as any)._load = function (request: string) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (nome: string) => (nome === "limas_session" ? { value: SESSAO } : undefined),
        set: () => {},
        delete: () => {},
      }),
      headers: async () => new Map(),
    };
  }
  if (request === "next/navigation") {
    return {
      redirect: (url: string) => {
        throw new Error("NEXT_REDIRECT:" + url);
      },
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
      useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request === "next/link" || request === "next/form" || request === "next/image")
    return { __esModule: true, default: (p: any) => p?.children ?? null, Link: (p: any) => p?.children ?? null };
  if (request === "server-only") return {};
  return carregarOriginal.apply(this, arguments as any);
};

const FUTURO = new Date(Date.now() + 864e5).toISOString();
const NORMAL = 2000; // R$ 20,00 — preço de catálogo
const PRODUTO = 880;
const CLIENTE = 1;
const DATA_PROMO = "2026-11-20"; // dentro da vigência padrão dos testes

function fd(pares: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(pares)) f.set(k, v);
  return f;
}

async function acao(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "";
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.startsWith("NEXT_REDIRECT:")) return msg.slice("NEXT_REDIRECT:".length);
    throw e;
  }
}

const carregar = (rel: string) => import(pathToFileURL(path.resolve(rel)).href);
const db = () => import("../src/lib/db.ts");
const um = async (s: string, p: any[] = []) => (await db()).one<any>(s, p);
const lista = async (s: string, p: any[] = []) => (await db()).all<any>(s, p);
const executar = async (s: string, p: any[] = []) => (await db()).run(s, p);
const centavos = (c: number | null | undefined) => ((c ?? 0) / 100).toFixed(2);

/** Banco novo + sessão de dono (empresa 1) + cliente + produto de catálogo. */
async function cenario() {
  const { createTestDb, resetTestDb } = await import("./helpers/d1.ts");
  resetTestDb();
  createTestDb();
  await executar(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0)`);
  await executar(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active)
     VALUES (11, 'Dono Preço', 'dono-preco', 'x', 'owner', 1, 1)`,
  );
  await executar(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 11, ?)`, [SESSAO, FUTURO]);
  await executar(`INSERT INTO customers (id, name, phone, company_id) VALUES (?, 'Cliente Preço', '31999990000', 1)`, [CLIENTE]);
  await executar(
    `INSERT INTO products (id, code, name, kind, total_qty, rent_price_cents, company_id, active)
     VALUES (?, 'PRECO-P', 'Produto Preço', 'simples', 60, ?, 1, 1)`,
    [PRODUTO, NORMAL],
  );
}

type Faixa = { min: number; max: number | null; preco: number };

/** Promoção direto na tabela (o formulário faria a mesma escrita). */
async function promocao(opts: { inicio?: string | null; fim?: string | null; faixas: Faixa[] }) {
  const id = await (await db()).insert(
    `INSERT INTO promotions (product_id, name, active, starts_on, ends_on, company_id) VALUES (?,?,1,?,?,1)`,
    [PRODUTO, "Promo preço", opts.inicio ?? null, opts.fim ?? null],
  );
  for (const f of opts.faixas) {
    await executar(
      `INSERT INTO promotion_tiers (promotion_id, min_qty, max_qty, unit_price_cents, company_id) VALUES (?,?,?,?,1)`,
      [id, f.min, f.max, f.preco],
    );
  }
  return id;
}

const PROMO_PADRAO: Faixa[] = [{ min: 5, max: null, preco: 1500 }]; // 5+ por R$ 15

/* ------------------------------------------------------------------ */
/* Helpers de formulário — replicam o que a tela envia                 */
/* ------------------------------------------------------------------ */

function fdReserva(r: any, items: any[], extra: Record<string, string> = {}) {
  return fd({
    id: String(r.id),
    customer_id: String(r.customer_id),
    event_date: r.event_date ?? "",
    event_time: r.event_time ?? "",
    address: r.address ?? "",
    district: r.district ?? "",
    city: r.city ?? "",
    delivery_at: r.delivery_at,
    pickup_at: r.pickup_at,
    needs_delivery: r.needs_delivery ? "1" : "",
    needs_pickup: r.needs_pickup ? "1" : "",
    freight: centavos(r.freight_cents),
    assembly: centavos(r.assembly_cents),
    disassembly: centavos(r.disassembly_cents),
    other: centavos(r.other_cents),
    discount: centavos(r.discount_cents),
    discount_expr: r.discount_expr ?? "",
    notes: r.notes ?? "",
    status: r.status,
    deposit: "0",
    items: JSON.stringify(items),
    ...extra,
  });
}

function fdQuote(q: any, items: any[], extra: Record<string, string> = {}) {
  return fd({
    id: String(q.id),
    customer_id: String(q.customer_id),
    event_date: q.event_date ?? "",
    event_time: q.event_time ?? "",
    address: q.address ?? "",
    district: q.district ?? "",
    city: q.city ?? "",
    delivery_at: q.delivery_at,
    pickup_at: q.pickup_at,
    valid_until: q.valid_until ?? "",
    freight: centavos(q.freight_cents),
    assembly: centavos(q.assembly_cents),
    disassembly: centavos(q.disassembly_cents),
    other: centavos(q.other_cents),
    discount: centavos(q.discount_cents),
    discount_expr: q.discount_expr ?? "",
    notes: q.notes ?? "",
    status: q.status,
    items: JSON.stringify(items),
    ...extra,
  });
}

/** Linha como a tela de edição devolve: preço gravado + origem + preservado. */
function linhaDoBanco(item: any, extra: Record<string, any> = {}) {
  return {
    product_id: item.product_id,
    qty: item.qty,
    unit_price_cents: item.unit_price_cents,
    discount_cents: item.discount_cents,
    discount_expr: item.discount_expr ?? null,
    price_source: item.price_source ?? null,
    base_price_cents: item.base_price_cents ?? null,
    promo_unit_price_cents: item.promo_unit_price_cents ?? null,
    promotion_id: item.promotion_id ?? null,
    preco_manual: item.price_source === "manual",
    preservado: true,
    ...extra,
  };
}

const itemReserva = (id: number) => lista(`SELECT * FROM reservation_items WHERE reservation_id = ? ORDER BY id`, [id]);
const itemQuote = (id: number) => lista(`SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id`, [id]);

async function novaReserva(items: any[], extra: Record<string, string> = {}) {
  const { createReservation } = await carregar("src/app/(app)/reservas/actions.ts");
  const url = await acao(() =>
    createReservation(
      null,
      fd({
        customer_id: String(CLIENTE),
        event_date: DATA_PROMO,
        status: "pre_reserva",
        items: JSON.stringify(items),
        ...extra,
      }),
    ),
  );
  assert.ok(url.startsWith("/reservas/"), `redirect inesperado: ${url}`);
  return Number(url.split("/").pop());
}

async function novoOrcamento(items: any[], extra: Record<string, string> = {}) {
  const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
  const url = await acao(() =>
    createQuote(
      null,
      fd({
        customer_id: String(CLIENTE),
        event_date: DATA_PROMO,
        status: "rascunho",
        items: JSON.stringify(items),
        ...extra,
      }),
    ),
  );
  assert.ok(url.startsWith("/orcamentos/"), `redirect inesperado: ${url}`);
  return Number(url.split("/").pop());
}

/* ------------------------------------------------------------------ */
/* 1, 2, 3, 4 — reserva: o valor gravado é a fonte da verdade          */
/* ------------------------------------------------------------------ */

describe("reserva — abrir e salvar não reprecifica", () => {
  beforeEach(cenario);

  it("cenário 1: reserva com promoção mantém o preço ao reabrir e salvar", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });
    const id = await novaReserva([{ product_id: PRODUTO, qty: 10, unit_price_cents: NORMAL }]);
    const antes = (await itemReserva(id))[0];
    assert.equal(antes.unit_price_cents, 1500, "criação aplica a promoção");
    assert.equal(antes.price_source, "promocao", "origem registrada");
    assert.equal(antes.base_price_cents, NORMAL, "valor original guardado para auditoria");
    assert.equal(antes.promo_unit_price_cents, 1500, "valor promocional calculado guardado");
    assert.ok(antes.promotion_id > 0, "promoção aplicada identificada");

    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() => updateReservation(null, fdReserva(r, [linhaDoBanco(antes)])));

    const depois = (await itemReserva(id))[0];
    assert.equal(depois.unit_price_cents, 1500, "valor idêntico ao gravado");
    const r2 = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    assert.equal(r2.total_cents, 15000, "total idêntico — 10 × R$ 15,00");
  });

  it("cenário 2: preço negociado manualmente sobrevive a reabrir, editar e salvar", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });
    const id = await novaReserva([
      { product_id: PRODUTO, qty: 10, unit_price_cents: 1700, preco_manual: true },
    ]);
    const antes = (await itemReserva(id))[0];
    assert.equal(antes.unit_price_cents, 1700, "negociação manda sobre a promoção");
    assert.equal(antes.price_source, "manual");
    assert.equal(antes.promo_unit_price_cents, 1500, "promoção calculada fica registrada ao lado");

    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() => updateReservation(null, fdReserva(r, [linhaDoBanco(antes)], { notes: "cliente confirmou" })));

    const depois = (await itemReserva(id))[0];
    assert.equal(depois.unit_price_cents, 1700, "preço negociado preservado");
    assert.equal(depois.price_source, "manual", "origem preservada");
  });

  it("exceção revertida: linha manual volta a usar a promoção quando o operador pede", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });
    const id = await novaReserva([{ product_id: PRODUTO, qty: 10, unit_price_cents: 1700, preco_manual: true }]);
    const antes = (await itemReserva(id))[0];
    assert.equal(antes.price_source, "manual");

    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    // clique em "Aplicar promoção" na linha preservada
    await acao(() =>
      updateReservation(
        null,
        fdReserva(r, [
          linhaDoBanco(antes, {
            unit_price_cents: 1500,
            preco_manual: false,
            price_source: "promocao",
            preservado: false,
          }),
        ]),
      ),
    );
    const depois = (await itemReserva(id))[0];
    assert.equal(depois.unit_price_cents, 1500, "promoção volta a valer");
    assert.equal(depois.price_source, "promocao", "origem corrigida para promoção");
    assert.ok(depois.promotion_id > 0, "promoção identificada");
  });

  it("volta ao preço de catálogo quando não há promoção aplicável", async () => {
    const id = await novaReserva([{ product_id: PRODUTO, qty: 3, unit_price_cents: 1700, preco_manual: true }]);
    const antes = (await itemReserva(id))[0];
    assert.equal(antes.price_source, "manual");

    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() =>
      updateReservation(
        null,
        fdReserva(r, [
          linhaDoBanco(antes, {
            unit_price_cents: NORMAL,
            preco_manual: false,
            price_source: "normal",
            preservado: false,
          }),
        ]),
      ),
    );
    const depois = (await itemReserva(id))[0];
    assert.equal(depois.unit_price_cents, NORMAL, "valor de catálogo restaurado");
    assert.equal(depois.price_source, "normal");
    assert.equal(depois.promotion_id, null);
  });

  it("cenário 3: alterar o percentual/valor da promoção não mexe na reserva antiga", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });
    const id = await novaReserva([{ product_id: PRODUTO, qty: 10, unit_price_cents: NORMAL }]);
    const antes = (await itemReserva(id))[0];
    assert.equal(antes.unit_price_cents, 1500);

    await executar(`UPDATE promotion_tiers SET unit_price_cents = 900`);
    await executar(`UPDATE promotions SET name = 'Promo alterada'`);

    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() => updateReservation(null, fdReserva(r, [linhaDoBanco(antes)])));

    assert.equal((await itemReserva(id))[0].unit_price_cents, 1500, "promoção alterada não reescreve o passado");
  });

  it("cenário 4: promoção nova que também se aplicaria não altera o registro antigo", async () => {
    const id = await novaReserva([{ product_id: PRODUTO, qty: 10, unit_price_cents: NORMAL }]);
    const antes = (await itemReserva(id))[0];
    assert.equal(antes.unit_price_cents, NORMAL);
    assert.equal(antes.price_source, "normal");

    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: [{ min: 1, max: null, preco: 1000 }] });

    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() => updateReservation(null, fdReserva(r, [linhaDoBanco(antes)])));

    assert.equal((await itemReserva(id))[0].unit_price_cents, NORMAL, "promoção nova só vale para documentos novos");
  });

  it("cenário 5: edição operacional preserva todos os valores financeiros", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });
    const id = await novaReserva([{ product_id: PRODUTO, qty: 10, unit_price_cents: NORMAL }], { freight: "80.00" });
    const antes = (await itemReserva(id))[0];
    const rAntes = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    assert.equal(rAntes.total_cents, 23000, "10 × R$ 15,00 + R$ 80,00 de frete");

    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() =>
      updateReservation(null, fdReserva(r, [linhaDoBanco(antes)], { notes: "entregar no salão", address: "Rua Nova, 10" })),
    );

    const rDepois = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    assert.equal(rDepois.notes, "entregar no salão");
    assert.equal(rDepois.items_cents, 15000);
    assert.equal(rDepois.freight_cents, 8000);
    assert.equal(rDepois.total_cents, 23000, "total intacto");
  });

  it("cenário 6: mudar quantidade não sobrescreve o preço negociado; aplicação é explícita", async () => {
    // duas promoções do mesmo produto, faixas diferentes (cadastro permite)
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: [{ min: 5, max: 9, preco: 1500 }] });
    const promoDez = await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: [{ min: 10, max: null, preco: 1200 }] });

    const id = await novaReserva([{ product_id: PRODUTO, qty: 5, unit_price_cents: NORMAL }]);
    const antes = (await itemReserva(id))[0];
    assert.equal(antes.unit_price_cents, 1500, "faixa de 5 a 9");

    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    // sobe a quantidade sem mexer no preço: 10 × R$ 15,00 — o combinado é preservado
    await acao(() => updateReservation(null, fdReserva(r, [linhaDoBanco(antes, { qty: 10 })])));
    const semAplicar = (await itemReserva(id))[0];
    assert.equal(semAplicar.unit_price_cents, 1500, "quantidade nova não reprica sozinha");
    assert.equal(semAplicar.subtotal_cents, 15000, "10 × R$ 15,00");

    // aplicação explícita da promoção de 10+ (o botão da tela)
    const r2 = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    await acao(() =>
      updateReservation(
        null,
        fdReserva(r2, [linhaDoBanco(semAplicar, { unit_price_cents: 1200, price_source: "promocao", preservado: false })]),
      ),
    );
    const aplicada = (await itemReserva(id))[0];
    assert.equal(aplicada.unit_price_cents, 1200, "promoção explícita aplicada");
    assert.equal(aplicada.price_source, "promocao");
    assert.equal(aplicada.promotion_id, promoDez);
    assert.equal(aplicada.subtotal_cents, 12000);
  });

  it("linha nova durante a edição usa a promoção vigente (só ela)", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });
    const id = await novaReserva([{ product_id: PRODUTO, qty: 10, unit_price_cents: 1800, preco_manual: true }]);
    const antes = (await itemReserva(id))[0];

    const { sellableProducts } = await import("../src/lib/stock.ts");
    const outro = await (await db()).insert(
      `INSERT INTO products (id, code, name, kind, total_qty, rent_price_cents, company_id, active)
       VALUES (990, 'NOVO-990', 'Produto Novo', 'simples', 20, 3000, 1, 1)`,
    );
    assert.ok((await sellableProducts(1)).some((p: any) => p.id === outro));

    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() =>
      updateReservation(
        null,
        fdReserva(r, [
          linhaDoBanco(antes),
          { product_id: outro, qty: 1, unit_price_cents: 3000, discount_cents: 0, discount_expr: null },
        ]),
      ),
    );
    const linhas = await itemReserva(id);
    assert.equal(linhas[0].unit_price_cents, 1800, "linha antiga preservada");
    assert.equal(linhas[1].unit_price_cents, 3000);
    assert.equal(linhas[1].price_source, "normal", "sem promoção para o produto novo");
  });

  it("registro legado (origem desconhecida) mantém preço e não inventa origem", async () => {
    // linha anterior à migração 0053: price_source NULL
    const id = await (await db()).insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, delivery_at, pickup_at, company_id)
       VALUES ('LIMA-900', ?, 'pre_reserva', '2026-11-20', '2026-11-20T08:00', '2026-11-21T08:00', 1)`,
      [CLIENTE],
    );
    await executar(
      `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents, discount_cents, company_id)
       VALUES (?, ?, 3, 1234, 0, 1)`,
      [id, PRODUTO],
    );
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: [{ min: 1, max: null, preco: 1000 }] });

    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    const item = (await itemReserva(id))[0];
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() => updateReservation(null, fdReserva(r, [linhaDoBanco(item)])));

    const depois = (await itemReserva(id))[0];
    assert.equal(depois.unit_price_cents, 1234, "preço histórico intacto");
    assert.equal(depois.price_source, null, "origem desconhecida continua desconhecida");
    assert.equal(depois.base_price_cents, null);
  });
});

/* ------------------------------------------------------------------ */
/* 7 — orçamentos: mesma regra                                        */
/* ------------------------------------------------------------------ */

describe("orçamento — abrir e salvar não reprecifica", () => {
  beforeEach(cenario);

  it("cenário 7a: orçamento com promoção preserva o valor ao editar", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });
    const id = await novoOrcamento([{ product_id: PRODUTO, qty: 10, unit_price_cents: NORMAL }]);
    const antes = (await itemQuote(id))[0];
    assert.equal(antes.unit_price_cents, 1500);
    assert.equal(antes.price_source, "promocao");

    const q = await um(`SELECT * FROM quotes WHERE id = ?`, [id]);
    const { updateQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() => updateQuote(null, fdQuote(q, [linhaDoBanco(antes)])));

    const depois = (await itemQuote(id))[0];
    assert.equal(depois.unit_price_cents, 1500);
    assert.equal(depois.price_source, "promocao");
    const q2 = await um(`SELECT * FROM quotes WHERE id = ?`, [id]);
    assert.equal(q2.total_cents, 15000);
  });

  it("cenário 7b: preço negociado no orçamento não é substituído pela promoção", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });
    const id = await novoOrcamento([{ product_id: PRODUTO, qty: 10, unit_price_cents: 1650, preco_manual: true }]);
    const antes = (await itemQuote(id))[0];
    assert.equal(antes.unit_price_cents, 1650);
    assert.equal(antes.price_source, "manual");

    const q = await um(`SELECT * FROM quotes WHERE id = ?`, [id]);
    const { updateQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() => updateQuote(null, fdQuote(q, [linhaDoBanco(antes)])));

    assert.equal((await itemQuote(id))[0].unit_price_cents, 1650);
  });

  it("cenário 7c: promoção nova/altered e mudança de data não mexem no orçamento gravado", async () => {
    const id = await novoOrcamento([{ product_id: PRODUTO, qty: 10, unit_price_cents: NORMAL }]);
    const antes = (await itemQuote(id))[0];
    assert.equal(antes.unit_price_cents, NORMAL);

    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: [{ min: 1, max: null, preco: 1000 }] });

    const q = await um(`SELECT * FROM quotes WHERE id = ?`, [id]);
    const { updateQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    // mesmo mudando a data para dentro da vigência, o valor gravado manda
    await acao(() => updateQuote(null, fdQuote(q, [linhaDoBanco(antes)], { event_date: DATA_PROMO })));
    const depois = (await itemQuote(id))[0];
    assert.equal(depois.unit_price_cents, NORMAL);
    assert.equal(depois.price_source, "normal");
  });

  it("edição de orçamento mantém itens manuais e recalcula só linhas novas", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });
    const id = await novoOrcamento([{ product_id: PRODUTO, qty: 10, unit_price_cents: 1700, preco_manual: true }]);
    const antes = (await itemQuote(id))[0];
    const outro = await (await db()).insert(
      `INSERT INTO products (id, code, name, kind, total_qty, rent_price_cents, company_id, active)
       VALUES (991, 'NOVO-991', 'Produto Novo Orçamento', 'simples', 20, 3000, 1, 1)`,
    );

    const q = await um(`SELECT * FROM quotes WHERE id = ?`, [id]);
    const { updateQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      updateQuote(
        null,
        fdQuote(q, [
          linhaDoBanco(antes),
          { product_id: outro, qty: 1, unit_price_cents: 3000, discount_cents: 0, discount_expr: null },
        ]),
      ),
    );
    const linhas = await itemQuote(id);
    assert.equal(linhas[0].unit_price_cents, 1700, "manual preservado");
    assert.equal(linhas[1].unit_price_cents, 3000);
  });
});

/* ------------------------------------------------------------------ */
/* 8 — conversão de orçamento em reserva                              */
/* ------------------------------------------------------------------ */

describe("conversão — o preço comercial atravessa intacto", () => {
  beforeEach(cenario);

  it("cenário 8a: orçamento promocional converte mantendo valor e origem", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });
    const id = await novoOrcamento([{ product_id: PRODUTO, qty: 10, unit_price_cents: NORMAL }]);
    const item = (await itemQuote(id))[0];

    const { convertQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    const url = await acao(() => convertQuote(fd({ id: String(id) })));
    assert.ok(url.startsWith("/reservas/"), `redirect inesperado: ${url}`);
    const reservaId = Number(url.split("/").pop());

    const naReserva = (await itemReserva(reservaId))[0];
    assert.equal(naReserva.unit_price_cents, 1500);
    assert.equal(naReserva.price_source, "promocao");
    assert.equal(naReserva.promotion_id, item.promotion_id);
    assert.equal(naReserva.base_price_cents, NORMAL);
    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    assert.equal(r.total_cents, 15000);
  });

  it("cenário 8b: orçamento manual converte preservando a negociação", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });
    const id = await novoOrcamento([{ product_id: PRODUTO, qty: 10, unit_price_cents: 1700, preco_manual: true }]);

    const { convertQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    const url = await acao(() => convertQuote(fd({ id: String(id) })));
    const reservaId = Number(url.split("/").pop());

    const naReserva = (await itemReserva(reservaId))[0];
    assert.equal(naReserva.unit_price_cents, 1700);
    assert.equal(naReserva.price_source, "manual");
  });
});

/* ------------------------------------------------------------------ */
/* 9 — pagamentos, adiantamentos e saldo                              */
/* ------------------------------------------------------------------ */

describe("pagamentos — total, recebido e saldo continuam consistentes", () => {
  beforeEach(cenario);

  it("cenário 9: abrir e editar a reserva não desalinha pagamentos nem saldo", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });
    const id = await novaReserva([{ product_id: PRODUTO, qty: 10, unit_price_cents: NORMAL }]);
    const antes = (await itemReserva(id))[0];

    const { addPayment } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() => addPayment(fd({ reservation_id: String(id), amount: "50.00", method: "pix" })));

    const { reservationMoney } = await import("../src/lib/reservations.ts");
    const antesEdicao = await reservationMoney(id, 1);
    assert.equal(antesEdicao.total, 15000);
    assert.equal(antesEdicao.paid, 5000);
    assert.equal(antesEdicao.balance, 10000);

    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [id]);
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() => updateReservation(null, fdReserva(r, [linhaDoBanco(antes)], { notes: "pagou sinal" })));

    const depois = await reservationMoney(id, 1);
    assert.equal(depois.total, 15000, "total não muda");
    assert.equal(depois.paid, 5000, "pagamento intacto");
    assert.equal(depois.balance, 10000, "saldo coerente");
  });
});

/* ------------------------------------------------------------------ */
/* 10 — regressão: documento NOVO continua usando promoções           */
/* ------------------------------------------------------------------ */

describe("regressão — criação continua aplicando promoções", () => {
  beforeEach(cenario);

  it("cenário 10: reserva e orçamento novos calculam a promoção vigente", async () => {
    await promocao({ inicio: "2026-11-01", fim: "2026-11-30", faixas: PROMO_PADRAO });

    const reservaId = await novaReserva([{ product_id: PRODUTO, qty: 10, unit_price_cents: NORMAL }]);
    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    assert.equal((await itemReserva(reservaId))[0].unit_price_cents, 1500);
    assert.equal(r.total_cents, 15000);

    const quoteId = await novoOrcamento([{ product_id: PRODUTO, qty: 10, unit_price_cents: NORMAL }]);
    const q = await um(`SELECT * FROM quotes WHERE id = ?`, [quoteId]);
    assert.equal((await itemQuote(quoteId))[0].unit_price_cents, 1500);
    assert.equal(q.total_cents, 15000);
  });

  it("preço de catálogo sem promoção é registrado como origem 'normal'", async () => {
    const reservaId = await novaReserva([{ product_id: PRODUTO, qty: 3, unit_price_cents: NORMAL }]);
    const item = (await itemReserva(reservaId))[0];
    assert.equal(item.unit_price_cents, NORMAL);
    assert.equal(item.price_source, "normal");
    assert.equal(item.base_price_cents, NORMAL);
    assert.equal(item.promotion_id, null);
  });
});
