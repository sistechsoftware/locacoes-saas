/**
 * CÓDIGO DE PRODUTO GERADO AUTOMATICAMENTE (item 1) + janela derivada do
 * evento no SERVIDOR (fallbacks das actions de reserva/orçamento).
 *
 * As actions REAIS do App Router são importadas fora do runtime do Next:
 * cookie da sessão, navigation e cache são scaffold mínimo; o banco é o
 * SQLite real com as migrations reais (tests/helpers/d1.ts).
 *
 * products.code é UNIQUE GLOBAL (migration 0001), então a série PROD-XXX
 * precisa ser lida por toda a base, não só pela empresa da sessão.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* Scaffold do Next: as actions importam next/*, que exige o runtime. */
const SESSAO = "sess-codigo-produto";
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
const PRODUTO_ANTIGO = 900;

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
const todos = async (s: string, p: any[] = []) => (await import("../src/lib/db.ts")).all<any>(s, p);

before(async () => {
  const { createTestDb, resetTestDb } = await import("./helpers/d1.ts");
  resetTestDb();
  createTestDb();
  const { run } = await import("../src/lib/db.ts");
  await run(`UPDATE companies SET name = 'Empresa A' WHERE id = 1`);
  await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa ZB', 1)`);
  await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0), (2, 0)`);
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active)
     VALUES (10, 'Dono A', 'dono-a-codigo', 'x', 'owner', 1, 1)`,
  );
  await run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 10, ?)`, [SESSAO, FUTURO]);
  await run(`INSERT INTO customers (id, name, phone, company_id) VALUES (1, 'Cliente Teste', '31999990000', 1)`);
  // produto antigo, cadastrado antes da automação, com código manual
  await run(
    `INSERT INTO products (id, code, name, kind, total_qty, company_id)
     VALUES (${PRODUTO_ANTIGO}, 'MESA', 'Mesa antiga', 'simples', 10, 1)`,
  );
});

/* ------------------------------------------------------------------ */
/* Item 1 — geração automática do código                               */
/* ------------------------------------------------------------------ */

describe("createProduct — código gerado pelo sistema", () => {
  it("gera PROD-001 quando o código vem em branco", async () => {
    const { createProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    await acao(() => createProduct(null, fd({ name: "Mesa Global", kind: "simples", total_qty: "5" })));
    const p = await um(`SELECT * FROM products WHERE name = 'Mesa Global'`);
    assert.equal(p.code, "PROD-001");
    assert.equal(p.company_id, 1, "produto nasce no tenant da sessão");
  });

  it("o próximo produto recebe o próximo número da série", async () => {
    const { createProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    await acao(() => createProduct(null, fd({ name: "Cadeira Auto", kind: "simples", total_qty: "8" })));
    const p = await um(`SELECT * FROM products WHERE name = 'Cadeira Auto'`);
    assert.equal(p.code, "PROD-002");
  });

  it("a série é GLOBAL: não reusa código de outra empresa", async () => {
    const { run } = await import("../src/lib/db.ts");
    await run(`INSERT INTO products (code, name, kind, total_qty, company_id) VALUES ('PROD-100', 'Da ZB', 'simples', 1, 2)`);
    const { createProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    await acao(() => createProduct(null, fd({ name: "Depois da ZB", kind: "simples", total_qty: "1" })));
    const p = await um(`SELECT * FROM products WHERE name = 'Depois da ZB'`);
    assert.equal(p.code, "PROD-101", "máximo lido por toda a base, respeitando o UNIQUE global");
  });

  it("código manual continua sendo aceito", async () => {
    const { createProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    await acao(() => createProduct(null, fd({ name: "Mesa Manual", kind: "simples", total_qty: "2", code: "MESA-X" })));
    const p = await um(`SELECT * FROM products WHERE name = 'Mesa Manual'`);
    assert.equal(p.code, "MESA-X");
  });

  it("duplicado na mesma empresa é barrado com a mensagem atual", async () => {
    const { createProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    const erro = await createProduct(null, fd({ name: "Clone", kind: "simples", total_qty: "1", code: "MESA-X" }));
    assert.equal(erro, "Já existe um produto com este código.");
  });

  it("duplicado em OUTRA empresa é barrado pelo UNIQUE global", async () => {
    const { run } = await import("../src/lib/db.ts");
    await run(`INSERT INTO products (code, name, kind, total_qty, company_id) VALUES ('DUP-EMP2', 'ZB', 'simples', 1, 2)`);
    const { createProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    const erro = await createProduct(null, fd({ name: "Clone ZB", kind: "simples", total_qty: "1", code: "DUP-EMP2" }));
    assert.equal(erro, "Já existe um produto com este código.");
    const vazou = await um(`SELECT * FROM products WHERE code = 'DUP-EMP2' AND company_id = 1`);
    assert.equal(vazou, undefined, "nada é gravado no tenant errado");
  });

  it("criações simultâneas nunca recebem o mesmo código", async () => {
    const { createProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    await Promise.all([
      acao(() => createProduct(null, fd({ name: "Sim A", kind: "simples", total_qty: "1" }))),
      acao(() => createProduct(null, fd({ name: "Sim B", kind: "simples", total_qty: "1" }))),
      acao(() => createProduct(null, fd({ name: "Sim C", kind: "simples", total_qty: "1" }))),
    ]);
    const linhas = await todos(`SELECT code FROM products WHERE name IN ('Sim A','Sim B','Sim C') ORDER BY code`);
    assert.equal(linhas.length, 3);
    const codigos = linhas.map((l: any) => l.code);
    assert.equal(new Set(codigos).size, 3, `códigos duplicados: ${codigos.join(", ")}`);
    assert.ok(codigos.every((c: string) => /^PROD-\d{3}$/.test(c)));
  });

  it("produtos antigos mantêm o código intacto", async () => {
    const p = await um(`SELECT * FROM products WHERE id = ${PRODUTO_ANTIGO}`);
    assert.equal(p.code, "MESA");
    assert.equal(p.name, "Mesa antiga");
  });

  it("unidades individuais usam o código gerado como prefixo", async () => {
    const { addUnits } = await carregar("src/app/(app)/estoque/actions.ts");
    const produto = await um(`SELECT * FROM products WHERE code = 'PROD-001'`);
    await acao(() => addUnits(fd({ product_id: String(produto.id), qty: "2" })));
    const unidades = await todos(`SELECT code FROM product_units WHERE product_id = ? ORDER BY code`, [produto.id]);
    assert.deepEqual(
      unidades.map((u: any) => u.code),
      ["PROD-001-001", "PROD-001-002"],
    );
  });
});

describe("updateProduct — código preservado na edição", () => {
  it("em branco, o código salvo é mantido", async () => {
    const { updateProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    const p = await um(`SELECT * FROM products WHERE code = 'MESA-X'`);
    await acao(() => updateProduct(null, fd({ id: String(p.id), name: "Mesa Manual Editada", kind: "simples", total_qty: "3" })));
    const depois = await um(`SELECT * FROM products WHERE id = ?`, [p.id]);
    assert.equal(depois.code, "MESA-X");
    assert.equal(depois.name, "Mesa Manual Editada");
  });

  it("trocar o código manualmente continua funcionando", async () => {
    const { updateProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    const p = await um(`SELECT * FROM products WHERE code = 'MESA-X'`);
    await acao(() => updateProduct(null, fd({ id: String(p.id), name: "Mesa Manual Editada", kind: "simples", total_qty: "3", code: "MESA-Y" })));
    const depois = await um(`SELECT * FROM products WHERE id = ?`, [p.id]);
    assert.equal(depois.code, "MESA-Y");
  });

  it("continua barrando código duplicado de outro produto da empresa", async () => {
    const { updateProduct } = await carregar("src/app/(app)/estoque/actions.ts");
    const p = await um(`SELECT * FROM products WHERE code = 'MESA-Y'`);
    const erro = await updateProduct(null, fd({ id: String(p.id), name: "Mesa Manual Editada", kind: "simples", total_qty: "3", code: "MESA" }));
    assert.equal(erro, "Já existe outro produto com este código.");
  });
});

/* ------------------------------------------------------------------ */
/* Item 2 — janela derivada do evento no SERVIDOR                      */
/* ------------------------------------------------------------------ */

describe("actions de reserva/orçamento — fallback da janela pelo evento", () => {
  it("orçamento sem entrega/retirada: entrega no evento e retirada D+1, no horário do evento", async () => {
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(
        null,
        fd({
          customer_id: "1",
          event_date: "2026-10-10",
          event_time: "18:00",
          status: "rascunho",
          items: JSON.stringify([{ product_id: String(PRODUTO_ANTIGO), qty: 1, unit_price_cents: 5000 }]),
        }),
      ),
    );
    const q = await um(`SELECT * FROM quotes ORDER BY id DESC LIMIT 1`);
    assert.equal(q.delivery_at, "2026-10-10T18:00");
    assert.equal(q.pickup_at, "2026-10-11T18:00");
  });

  it("orçamento sem entrega/retirada e sem horário: fallbacks 08:00/18:00", async () => {
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    await acao(() =>
      createQuote(
        null,
        fd({
          customer_id: "1",
          event_date: "2026-10-20",
          status: "rascunho",
          items: JSON.stringify([{ product_id: String(PRODUTO_ANTIGO), qty: 2, unit_price_cents: 5000 }]),
        }),
      ),
    );
    const q = await um(`SELECT * FROM quotes ORDER BY id DESC LIMIT 1`);
    assert.equal(q.delivery_at, "2026-10-20T08:00");
    assert.equal(q.pickup_at, "2026-10-21T18:00");
  });

  it("reserva sem entrega/retirada: entrega no evento e retirada D+1, no horário do evento", async () => {
    const { createReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await acao(() =>
      createReservation(
        null,
        fd({
          customer_id: "1",
          event_date: "2026-11-20",
          event_time: "14:30",
          status: "pre_reserva",
          items: JSON.stringify([{ product_id: String(PRODUTO_ANTIGO), qty: 1, unit_price_cents: 1000 }]),
        }),
      ),
    );
    const r = await um(`SELECT * FROM reservations ORDER BY id DESC LIMIT 1`);
    assert.equal(r.delivery_at, "2026-11-20T14:30");
    assert.equal(r.pickup_at, "2026-11-21T14:30");
  });

  it("edição de reserva preserva exatamente os horários manuais enviados", async () => {
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    const r = await um(`SELECT * FROM reservations ORDER BY id DESC LIMIT 1`);
    await acao(() =>
      updateReservation(
        null,
        fd({
          id: String(r.id),
          customer_id: "1",
          event_date: "2026-11-20",
          event_time: "14:30",
          delivery_at: "2026-11-20T15:00",
          pickup_at: "2026-11-22T10:00",
          status: "pre_reserva",
          items: JSON.stringify([{ product_id: String(PRODUTO_ANTIGO), qty: 1, unit_price_cents: 1000 }]),
        }),
      ),
    );
    const depois = await um(`SELECT * FROM reservations WHERE id = ?`, [r.id]);
    assert.equal(depois.delivery_at, "2026-11-20T15:00");
    assert.equal(depois.pickup_at, "2026-11-22T10:00");
  });

  it("edição de orçamento preserva exatamente os horários manuais enviados", async () => {
    const { updateQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    const q = await um(`SELECT * FROM quotes ORDER BY id DESC LIMIT 1`);
    await acao(() =>
      updateQuote(
        null,
        fd({
          id: String(q.id),
          customer_id: "1",
          event_date: "2026-10-20",
          delivery_at: "2026-10-20T09:15",
          pickup_at: "2026-10-23T07:45",
          status: "rascunho",
          items: JSON.stringify([{ product_id: String(PRODUTO_ANTIGO), qty: 2, unit_price_cents: 5000 }]),
        }),
      ),
    );
    const depois = await um(`SELECT * FROM quotes WHERE id = ?`, [q.id]);
    assert.equal(depois.delivery_at, "2026-10-20T09:15");
    assert.equal(depois.pickup_at, "2026-10-23T07:45");
  });
});
