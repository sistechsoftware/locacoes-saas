/**
 * DESCONTO FLEXÍVEL R$ OU % (migração 0046).
 *
 * Duas camadas:
 *  1. As regras puras de `lib/desconto.ts` (parse, cálculo, rótulo);
 *  2. As actions REAIS do App Router fora do runtime do Next (mesmo scaffold
 *     de codigo-produto.test.ts), provando que a forma escolhida pelo
 *     operador é gravada, normalizada e convertida junto na virada de
 *     orçamento em reserva.
 *
 * O dinheiro cobrado continua sendo discount_cents — os totais não mudam.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* Scaffold do Next: as actions importam next/*, que exige o runtime. */
const SESSAO = "sess-desconto";
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
const PRODUTO = 950;

function fd(pares: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(pares)) f.set(k, v);
  return f;
}

/** Chama uma action; devolve a URL do NEXT_REDIRECT ou "" em actions void. */
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
const um = async (s: string, p: any[] = []) => (await import("../src/lib/db.ts")).one<any>(s, p);

/* Regras puras: import dinâmico dentro dos testes (CJS do tsx não tem top-level await). */
const desc = () => import("../src/lib/desconto.ts");

before(async () => {
  const { createTestDb, resetTestDb } = await import("./helpers/d1.ts");
  resetTestDb();
  createTestDb();
  const { run } = await import("../src/lib/db.ts");
  await run(`UPDATE companies SET name = 'Empresa Desconto' WHERE id = 1`);
  await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0)`);
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active)
     VALUES (10, 'Dono Desconto', 'dono-desconto', 'x', 'owner', 1, 1)`,
  );
  await run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 10, ?)`, [SESSAO, FUTURO]);
  await run(`INSERT INTO customers (id, name, phone, company_id) VALUES (1, 'Cliente Desconto', '31999990000', 1)`);
  await run(
    `INSERT INTO products (id, code, name, kind, total_qty, company_id)
     VALUES (${PRODUTO}, 'MESA-D', 'Mesa Desconto', 'simples', 20, 1)`,
  );
});

/* ------------------------------------------------------------------ */
/* 1 — regras puras                                                    */
/* ------------------------------------------------------------------ */

describe("lib/desconto.ts — parse da expressão", () => {
  it("lê percentuais nos formatos aceitos", async () => {
    const { pctDeExpr } = await desc();
    assert.equal(pctDeExpr("10%"), 10);
    assert.equal(pctDeExpr("10,5%"), 10.5);
    assert.equal(pctDeExpr("10.5%"), 10.5);
    assert.equal(pctDeExpr("  10% "), 10);
  });

  it("recusa lixo, zero e valores fora da faixa", async () => {
    const { pctDeExpr } = await desc();
    assert.equal(pctDeExpr("150%"), null);
    assert.equal(pctDeExpr("0%"), null);
    assert.equal(pctDeExpr("abc"), null);
    assert.equal(pctDeExpr("10 %%"), null);
    assert.equal(pctDeExpr(""), null);
    assert.equal(pctDeExpr(null), null);
    assert.equal(pctDeExpr(10 as any), null);
  });

  it("normaliza para o formato gravado (vírgula decimal)", async () => {
    const { exprDePct } = await desc();
    assert.equal(exprDePct(10), "10%");
    assert.equal(exprDePct(12.5), "12,5%");
    assert.equal(exprDePct(12.345), "12,35%");
    assert.equal(exprDePct(0), null);
    assert.equal(exprDePct(101), null);
    assert.equal(exprDePct(NaN), null);
  });

  it("lê o percentual digitado no form (aceita vírgula e ponto)", async () => {
    const { pctDigitado } = await desc();
    assert.equal(pctDigitado("10"), 10);
    assert.equal(pctDigitado("10,5"), 10.5);
    assert.equal(pctDigitado("10.5"), 10.5);
    assert.equal(pctDigitado("10%"), 10);
    assert.equal(pctDigitado(""), null);
    assert.equal(pctDigitado("abc"), null);
    assert.equal(pctDigitado("150"), null);
  });

  it("ZERO digitado remove o desconto em vez de ser ignorado (regressão do revert)", async () => {
    const { pctDigitado, descontoDePct, exprDePct } = await desc();
    // o gesto natural de remover um 10% é digitar "0" — tinha que zerar
    assert.equal(pctDigitado("0"), 0);
    assert.equal(pctDigitado("0,0"), 0);
    assert.equal(pctDigitado("0%"), 0);
    // e a cadeia inteira do form zera: dinheiro 0 e expressão apagada
    assert.equal(descontoDePct(15000, 0), 0);
    assert.equal(exprDePct(0), null);
  });

  it("exprValida só aceita formato de percentual e normaliza", async () => {
    const { exprValida } = await desc();
    assert.equal(exprValida("10%"), "10%");
    assert.equal(exprValida("12.5%"), "12,5%");
    assert.equal(exprValida("150%"), null);
    assert.equal(exprValida("50 reais"), null);
    assert.equal(exprValida(""), null);
    assert.equal(exprValida(null), null);
  });
});

describe("lib/desconto.ts — cálculo e rótulo", () => {
  it("calcula o percentual sobre a base com arredondamento de centavo", async () => {
    const { descontoDePct } = await desc();
    assert.equal(descontoDePct(15000, 10), 1500);
    assert.equal(descontoDePct(999, 10), 100); // 99,9 -> 100
    assert.equal(descontoDePct(15000, 12.5), 1875);
  });

  it("limita o desconto à própria base e ignora base negativa", async () => {
    const { descontoDePct } = await desc();
    assert.equal(descontoDePct(1000, 150), 1000);
    assert.equal(descontoDePct(0, 10), 0);
    assert.equal(descontoDePct(-5, 10), 0);
  });

  it("rótulo reabre como \"10% (R$ 150,00)\" e sem expressão só o dinheiro", async () => {
    const { rotuloDesconto } = await desc();
    /* money() em pt-BR usa espaço não separável depois de R$ (NBSP, U+00A0). */
    assert.equal(rotuloDesconto(15000, "10%"), "10% (R$\u00A0150,00)");
    assert.equal(rotuloDesconto(1875, "12,5%"), "12,5% (R$\u00A018,75)");
    assert.equal(rotuloDesconto(15000, null), "R$\u00A0150,00");
    assert.equal(rotuloDesconto(15000, "lixo"), "R$\u00A0150,00");
  });
});

/* ------------------------------------------------------------------ */
/* 2 — actions reais com banco de teste                                */
/* ------------------------------------------------------------------ */

describe("actions — desconto percentual gravado e normalizado", () => {
  it("createQuote guarda o dinheiro E a expressão", async () => {
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(
        null,
        fd({
          customer_id: "1",
          event_date: "2026-11-05",
          status: "rascunho",
          discount: "150.00",
          discount_expr: "10%",
          items: JSON.stringify([{ product_id: String(PRODUTO), qty: 1, unit_price_cents: 15000 }]),
        }),
      ),
    );
    const q = await um(`SELECT * FROM quotes ORDER BY id DESC LIMIT 1`);
    assert.equal(q.discount_cents, 15000);
    assert.equal(q.discount_expr, "10%");
  });

  it("expressão com ponto é normalizada para vírgula ao gravar", async () => {
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(
        null,
        fd({
          customer_id: "1",
          event_date: "2026-11-06",
          status: "rascunho",
          discount: "125.00",
          discount_expr: "12.5%",
          items: JSON.stringify([{ product_id: String(PRODUTO), qty: 1, unit_price_cents: 1000 }]),
        }),
      ),
    );
    const q = await um(`SELECT * FROM quotes ORDER BY id DESC LIMIT 1`);
    assert.equal(q.discount_expr, "12,5%");
  });

  it("texto que não é percentual vira NULL — o dinheiro continua valendo", async () => {
    const { createReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() =>
      createReservation(
        null,
        fd({
          customer_id: "1",
          event_date: "2026-11-07",
          status: "pre_reserva",
          discount: "50.00",
          discount_expr: "abc",
          items: JSON.stringify([{ product_id: String(PRODUTO), qty: 1, unit_price_cents: 1000 }]),
        }),
      ),
    );
    const r = await um(`SELECT * FROM reservations ORDER BY id DESC LIMIT 1`);
    assert.equal(r.discount_cents, 5000);
    assert.equal(r.discount_expr, null);
  });

  it("editar sem expressão (modo R$) limpa o que estava gravado", async () => {
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    const r = await um(`SELECT * FROM reservations ORDER BY id DESC LIMIT 1`);
    await acao(() =>
      updateReservation(
        null,
        fd({
          id: String(r.id),
          customer_id: "1",
          event_date: "2026-11-07",
          status: "pre_reserva",
          discount: "80.00",
          discount_expr: "",
          items: JSON.stringify([{ product_id: String(PRODUTO), qty: 1, unit_price_cents: 1000 }]),
        }),
      ),
    );
    const depois = await um(`SELECT * FROM reservations WHERE id = ?`, [r.id]);
    assert.equal(depois.discount_cents, 8000);
    assert.equal(depois.discount_expr, null);
  });

  it("desconto percentual de item é gravado na linha e o subtotal não muda de fórmula", async () => {
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(
        null,
        fd({
          customer_id: "1",
          event_date: "2026-11-08",
          status: "rascunho",
          items: JSON.stringify([
            { product_id: String(PRODUTO), qty: 2, unit_price_cents: 5000, discount_cents: 500, discount_expr: "5%" },
          ]),
        }),
      ),
    );
    const q = await um(`SELECT * FROM quotes ORDER BY id DESC LIMIT 1`);
    const item = await um(`SELECT * FROM quote_items WHERE quote_id = ?`, [q.id]);
    assert.equal(item.discount_cents, 500);
    assert.equal(item.discount_expr, "5%");
    assert.equal(item.subtotal_cents, 9500); // 2 × 5000 − 500, fórmula de sempre
  });

  it("converter orçamento em reserva leva a expressão do cabeçalho e dos itens", async () => {
    const { createQuote, convertQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(
        null,
        fd({
          customer_id: "1",
          event_date: "2026-11-09",
          event_time: "10:00",
          status: "rascunho",
          discount: "300.00",
          discount_expr: "10%",
          items: JSON.stringify([
            { product_id: String(PRODUTO), qty: 1, unit_price_cents: 3000, discount_cents: 300, discount_expr: "10%" },
          ]),
        }),
      ),
    );
    const q = await um(`SELECT * FROM quotes ORDER BY id DESC LIMIT 1`);
    const url = await acao(() => convertQuote(fd({ id: String(q.id) })));
    assert.ok(url.startsWith("/reservas/"), `redirect inesperado: ${url}`);
    const reservaId = Number(url.split("/").pop());
    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    assert.equal(r.discount_cents, 30000); // R$ 300,00 do orçamento convertido
    assert.equal(r.discount_expr, "10%");
    const item = await um(`SELECT * FROM reservation_items WHERE reservation_id = ?`, [reservaId]);
    assert.equal(item.discount_cents, 300);
    assert.equal(item.discount_expr, "10%");
  });
});
