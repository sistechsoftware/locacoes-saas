/**
 * PREÇOS POR PERÍODO (Fase 1 da auditoria de períodos/preços).
 *
 * Três frentes, todas com SQLite real e migrations reais (tests/helpers/d1.ts):
 *   1. CARACTERIZAÇÃO (Fase 0): a fórmula antiga qty × unit − discount vive
 *      quando period_qty = 1 (default da migração) — totais históricos não
 *      mudam um centavo e a migração é backward-compatible.
 *   2. MODALIDADE: dias de calendário, precedência produto > empresa > fixo,
 *      período recalculado NO SERVIDOR a partir da janela (o cliente não envia
 *      período — readItems descarta o que vier).
 *   3. INTEGRAÇÃO: createQuote/createReservation gravam pricing_mode/period_qty
 *      e o total bate com qty × período × unit − discount.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* Scaffold do Next: as actions importam next/*, que exige o runtime. */
const SESSAO = "sess-precos-periodo";
const carregarOriginal = (Module as any)._load;

(Module as any)._load = function (request: string) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({ get: (nome: string) => (nome === "limas_session" ? { value: SESSAO } : undefined), set: () => {}, delete: () => {} }),
      headers: async () => new Map(),
    };
  }
  if (request === "next/navigation") {
    return {
      redirect: (url: string) => { throw new Error("NEXT_REDIRECT:" + url); },
      notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
      useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request === "next/link" || request === "next/form" || request === "next/image") {
    return { __esModule: true, default: (p: any) => p?.children ?? null, Link: (p: any) => p?.children ?? null };
  }
  if (request === "server-only") return {};
  return carregarOriginal.apply(this, arguments as any);
};

const FUTURO = new Date(Date.now() + 864e5).toISOString();

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
const um = async (s: string, p: any[] = []) => (await import("../src/lib/db.ts")).one<any>(s, p);
const todos = async (s: string, p: any[] = []) => (await import("../src/lib/db.ts")).all<any>(s, p);

const MESA = 11;
const CADEIRA_DIARIA = 12;

before(async () => {
  const { createTestDb, resetTestDb } = await import("./helpers/d1.ts");
  resetTestDb();
  createTestDb();
  const { run, insert } = await import("../src/lib/db.ts");
  await run(`UPDATE companies SET name = 'Empresa A' WHERE id = 1`);
  await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0)`);
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active)
     VALUES (10, 'Dono A', 'dono-a-precos', 'x', 'owner', 1, 1)`,
  );
  await run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 10, ?)`, [SESSAO, FUTURO]);
  await run(`INSERT INTO customers (id, name, phone, company_id) VALUES (1, 'Cliente Teste', '31999990000', 1)`);
  // Mesa: modalidade FIXA explícita (comportamento atual preservado).
  await run(
    `INSERT INTO products (id, code, name, kind, total_qty, rent_price_cents, pricing_mode, company_id)
     VALUES (${MESA}, 'MESA-P', 'Mesa', 'simples', 100, 8000, 'fixo', 1)`,
  );
  // Cadeira: modalidade DIÁRIA explícita (R$ 20,00 por diária).
  await run(
    `INSERT INTO products (id, code, name, kind, total_qty, rent_price_cents, pricing_mode, company_id)
     VALUES (${CADEIRA_DIARIA}, 'CAD-P', 'Cadeira', 'simples', 100, 2000, 'diaria', 1)`,
  );
  // Linha antiga, pré-migração: gravada sem as colunas novas.
  await run(`INSERT INTO reservations (id, number, customer_id, status, event_date, delivery_at, pickup_at) VALUES (900, 'LIMA-900', 1, 'confirmada', '2026-09-10', '2026-09-10T08:00', '2026-09-11T10:00')`);
  await run(`INSERT INTO reservation_items (id, reservation_id, product_id, qty, unit_price_cents, discount_cents, subtotal_cents, company_id) VALUES (900, 900, ${MESA}, 3, 8000, 500, 23500, 1)`);
  void insert;
});

/* ------------------------------------------------------------------ */
/* 1. Caracterização (Fase 0) — a fórmula antiga vive com period_qty=1 */
/* ------------------------------------------------------------------ */

describe("Caracterização — fórmula atual preservada", () => {
  it("linha pré-migração nasce com ('fixo', 1) e subtotal não muda", async () => {
    const row = await um(`SELECT * FROM reservation_items WHERE id = 900`);
    assert.equal(row.pricing_mode, "fixo", "default da migração 0044");
    assert.equal(row.period_qty, 1, "default da migração 0044");
    assert.equal(row.subtotal_cents, 23500, "subtotal gravado antes da migração intacto");
  });

  it("recalc sobre linha antiga reproduz qty × unit − discount exatamente", async () => {
    const { recalcReservation } = await carregar("src/lib/reservations.ts");
    await recalcReservation(900);
    const row = await um(`SELECT * FROM reservation_items WHERE id = 900`);
    // 3 × 8000 − 500 = 23500 — idêntico à fórmula anterior sem período.
    assert.equal(row.subtotal_cents, 3 * 8000 - 500);
    const r = await um(`SELECT items_cents, total_cents FROM reservations WHERE id = 900`);
    assert.equal(r.items_cents, 23500);
    assert.equal(r.total_cents, 23500);
  });

  it("inserts antigos sem as colunas novas continuam aceitos (defaults)", async () => {
    const { insert } = await import("../src/lib/db.ts");
    const { recalcReservation } = await carregar("src/lib/reservations.ts");
    const id = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, delivery_at, pickup_at)
       VALUES ('LIMA-901', 1, 'confirmada', '2026-09-10', '2026-09-10T08:00', '2026-09-11T10:00')`,
    );
    await insert(
      `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents) VALUES (?,?,?,?)`,
      [id, MESA, 2, 8000],
    );
    await recalcReservation(id);
    const item = await um(`SELECT * FROM reservation_items WHERE reservation_id = ?`, [id]);
    assert.equal(item.pricing_mode, "fixo");
    assert.equal(item.period_qty, 1);
    assert.equal(item.subtotal_cents, 16000);
  });
});

/* ------------------------------------------------------------------ */
/* 2. diasCobrados — regra aprovada: dia de calendário, mínimo 1        */
/* ------------------------------------------------------------------ */

describe("diasCobrados — duração por dia de calendário", () => {
  it("entrega sáb, retirada dom = 1 diária", async () => {
    const { diasCobrados } = await carregar("src/lib/format.ts");
    assert.equal(diasCobrados("2026-11-07T08:00", "2026-11-08T18:00"), 1);
  });

  it("mesmo dia (janela < 24h) = 1 diária", async () => {
    const { diasCobrados } = await carregar("src/lib/format.ts");
    assert.equal(diasCobrados("2026-11-07T09:00", "2026-11-07T18:00"), 1);
    assert.equal(diasCobrados("2026-11-07T22:00", "2026-11-07T23:30"), 1);
  });

  it("2, 3 e 7 dias de calendário", async () => {
    const { diasCobrados } = await carregar("src/lib/format.ts");
    assert.equal(diasCobrados("2026-11-07T08:00", "2026-11-09T10:00"), 2);
    assert.equal(diasCobrados("2026-11-07T08:00", "2026-11-10T10:00"), 3);
    assert.equal(diasCobrados("2026-11-07T08:00", "2026-11-14T18:00"), 7);
  });

  it("o horário não cria diária: 20h → 06h do dia seguinte = 1", async () => {
    const { diasCobrados } = await carregar("src/lib/format.ts");
    assert.equal(diasCobrados("2026-11-07T20:00", "2026-11-08T06:00"), 1);
  });

  it("janela ausente devolve 1 (nunca cobra menos que uma diária)", async () => {
    const { diasCobrados } = await carregar("src/lib/format.ts");
    assert.equal(diasCobrados("", ""), 1);
    assert.equal(diasCobrados(null, null), 1);
    assert.equal(diasCobrados("2026-11-07T08:00", undefined), 1);
  });
});

/* ------------------------------------------------------------------ */
/* 3. aplicarPrecos — resolução server-side                           */
/* ------------------------------------------------------------------ */

describe("aplicarPrecos — modalidade e período no servidor", () => {
  const janela3d = { delivery_at: "2026-11-07T08:00", pickup_at: "2026-11-10T10:00" };

  it("produto 'diaria' cobra os dias da janela; 'fixo' cobra 1", async () => {
    const { aplicarPrecos } = await carregar("src/lib/pricing.ts");
    const [fixo, diaria] = await aplicarPrecos(
      [
        { product_id: MESA, qty: 3, unit_price_cents: 8000, discount_cents: 0 },
        { product_id: CADEIRA_DIARIA, qty: 10, unit_price_cents: 2000, discount_cents: 0 },
      ],
      janela3d,
      1,
    );
    assert.equal(fixo.pricing_mode, "fixo");
    assert.equal(fixo.period_qty, 1);
    assert.equal(diaria.pricing_mode, "diaria");
    assert.equal(diaria.period_qty, 3, "3 dias de calendário da janela");
  });

  it("produto sem modalidade herda o default da empresa", async () => {
    const { insert, run } = await import("../src/lib/db.ts");
    const { aplicarPrecos } = await carregar("src/lib/pricing.ts");
    const neutro = await insert(
      `INSERT INTO products (code, name, kind, total_qty, rent_price_cents, company_id)
       VALUES ('NEUTRO-P', 'Produto neutro', 'simples', 10, 5000, 1)`,
    );
    const [padrao] = await aplicarPrecos([{ product_id: neutro, qty: 1 }], janela3d, 1);
    assert.equal(padrao.pricing_mode, "fixo", "default da plataforma é 'fixo'");

    await run(`INSERT INTO company_settings (company_id, key, value) VALUES (1, 'pricing_default_mode', 'diaria')`);
    const [herdado] = await aplicarPrecos([{ product_id: neutro, qty: 1 }], janela3d, 1);
    assert.equal(herdado.pricing_mode, "diaria", "empresa 'diaria' vence o NULL do produto");
    assert.equal(herdado.period_qty, 3);

    // Precedência: produto explícito vence o default da empresa.
    const [fixoExp] = await aplicarPrecos([{ product_id: MESA, qty: 1 }], janela3d, 1);
    assert.equal(fixoExp.pricing_mode, "fixo", "produto 'fixo' explícito vence empresa 'diaria'");
    const [diariaExp] = await aplicarPrecos([{ product_id: CADEIRA_DIARIA, qty: 1 }], janela3d, 1);
    assert.equal(diariaExp.pricing_mode, "diaria");

    // limpa o default para não vazar para os próximos testes
    await run(`DELETE FROM company_settings WHERE company_id = 1 AND key = 'pricing_default_mode'`);
    await run(`DELETE FROM products WHERE id = ?`, [neutro]);
  });

  it("linha que já traz pricing_mode do banco preserva a modalidade (conversão)", async () => {
    const { aplicarPrecos } = await carregar("src/lib/pricing.ts");
    // orçamento gravado como 'diaria' convertido depois de o produto mudar para 'fixo'
    const [conv] = await aplicarPrecos(
      [{ product_id: MESA, qty: 2, pricing_mode: "diaria", period_qty: 99 }],
      janela3d,
      1,
    );
    assert.equal(conv.pricing_mode, "diaria", "snapshot da linha preservado");
    assert.equal(conv.period_qty, 3, "período recalculado da janela da reserva");
  });

  it("lixo em pricing_mode cai no default (nunca grava modalidade inválida)", async () => {
    const { aplicarPrecos } = await carregar("src/lib/pricing.ts");
    const [lixo] = await aplicarPrecos([{ product_id: MESA, qty: 1, pricing_mode: "hacked" }], janela3d, 1);
    assert.equal(lixo.pricing_mode, "fixo", "produto resolve antes do lixo da linha");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Integração — actions reais gravam e recalculam                    */
/* ------------------------------------------------------------------ */

describe("actions — período gravado por linha, total bate", () => {
  it("createQuote: cadeira × 3 diárias × R$ 20 = R$ 600, sem duplicar produto", async () => {
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    const url = await acao(() =>
      createQuote(
        null,
        fd({
          customer_id: "1",
          status: "enviado",
          event_date: "2026-11-07",
          delivery_at: "2026-11-07T08:00",
          pickup_at: "2026-11-10T10:00",
          items: JSON.stringify([
            { product_id: String(CADEIRA_DIARIA), qty: "10", unit_price_cents: 2000, discount_cents: 0, period_qty: 99 },
          ]),
        }),
      ),
    );
    const id = Number(url.split("/").pop());
    assert.ok(id > 0, `redirect inesperado: ${url}`);
    const item = await um(`SELECT * FROM quote_items WHERE quote_id = ?`, [id]);
    assert.equal(item.pricing_mode, "diaria");
    assert.equal(item.period_qty, 3, "período vindo da janela, NÃO do cliente (que enviou 99)");
    assert.equal(item.subtotal_cents, 10 * 3 * 2000, "R$ 600,00");
    const q = await um(`SELECT items_cents, total_cents FROM quotes WHERE id = ?`, [id]);
    assert.equal(q.items_cents, 60000);
    assert.equal(q.total_cents, 60000);
  });

  it("createQuote: produto 'fixo' em janela de 3 dias continua cobrando 1", async () => {
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    const url = await acao(() =>
      createQuote(
        null,
        fd({
          customer_id: "1",
          status: "rascunho",
          event_date: "2026-11-07",
          delivery_at: "2026-11-07T08:00",
          pickup_at: "2026-11-10T10:00",
          items: JSON.stringify([{ product_id: String(MESA), qty: "3", unit_price_cents: 8000, discount_cents: 1000 }]),
        }),
      ),
    );
    const id = Number(url.split("/").pop());
    const item = await um(`SELECT * FROM quote_items WHERE quote_id = ?`, [id]);
    assert.equal(item.pricing_mode, "fixo");
    assert.equal(item.period_qty, 1);
    assert.equal(item.subtotal_cents, 3 * 8000 - 1000, "fórmula antiga intacta");
  });

  it("updateQuote: mudar a janela recalcula o período no servidor", async () => {
    const { createQuote, updateQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    const url = await acao(() =>
      createQuote(
        null,
        fd({
          customer_id: "1",
          status: "rascunho",
          event_date: "2026-11-07",
          delivery_at: "2026-11-07T08:00",
          pickup_at: "2026-11-08T10:00",
          items: JSON.stringify([{ product_id: String(CADEIRA_DIARIA), qty: "5", unit_price_cents: 2000 }]),
        }),
      ),
    );
    const id = Number(url.split("/").pop());
    const antes = await um(`SELECT period_qty FROM quote_items WHERE quote_id = ?`, [id]);
    assert.equal(antes.period_qty, 1);

    await acao(() =>
      updateQuote(
        null,
        fd({
          id: String(id),
          customer_id: "1",
          status: "rascunho",
          event_date: "2026-11-07",
          delivery_at: "2026-11-07T08:00",
          pickup_at: "2026-11-13T10:00",
          items: JSON.stringify([{ product_id: String(CADEIRA_DIARIA), qty: "5", unit_price_cents: 2000 }]),
        }),
      ),
    );
    const depois = await um(`SELECT period_qty, subtotal_cents FROM quote_items WHERE quote_id = ?`, [id]);
    assert.equal(depois.period_qty, 6, "retirada estendida: 6 dias de calendário");
    assert.equal(depois.subtotal_cents, 5 * 6 * 2000);
  });

  it("createReservation: writeRental grava período da janela e o total confere", async () => {
    const { createReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    const url = await acao(() =>
      createReservation(
        null,
        fd({
          customer_id: "1",
          status: "confirmada",
          event_date: "2026-11-07",
          delivery_at: "2026-11-07T09:00",
          pickup_at: "2026-11-11T09:00",
          items: JSON.stringify([
            { product_id: String(CADEIRA_DIARIA), qty: "10", unit_price_cents: 2000 },
            { product_id: String(MESA), qty: "2", unit_price_cents: 8000 },
          ]),
        }),
      ),
    );
    const id = Number(url.split("?")[0].split("/").pop());
    assert.ok(id > 0, `redirect inesperado: ${url}`);
    const linhas = await todos(`SELECT * FROM reservation_items WHERE reservation_id = ? ORDER BY id`, [id]);
    assert.equal(linhas.length, 2, "uma linha por produto — nada duplicado");
    const cadeira = linhas.find((l: any) => l.product_id === CADEIRA_DIARIA);
    const mesa = linhas.find((l: any) => l.product_id === MESA);
    assert.equal(cadeira.pricing_mode, "diaria");
    assert.equal(cadeira.period_qty, 4, "07/11 → 11/11 = 4 dias de calendário");
    assert.equal(cadeira.subtotal_cents, 10 * 4 * 2000);
    assert.equal(mesa.pricing_mode, "fixo");
    assert.equal(mesa.period_qty, 1);
    assert.equal(mesa.subtotal_cents, 2 * 8000);
    const r = await um(`SELECT items_cents FROM reservations WHERE id = ?`, [id]);
    assert.equal(r.items_cents, 10 * 4 * 2000 + 2 * 8000);
  });

  it("convertQuote preserva o snapshot da linha na reserva", async () => {
    const { createQuote, convertQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    const url = await acao(() =>
      createQuote(
        null,
        fd({
          customer_id: "1",
          status: "enviado",
          event_date: "2026-11-20",
          delivery_at: "2026-11-20T08:00",
          pickup_at: "2026-11-23T08:00",
          items: JSON.stringify([{ product_id: String(CADEIRA_DIARIA), qty: "4", unit_price_cents: 2000 }]),
        }),
      ),
    );
    const quoteId = Number(url.split("/").pop());
    const convUrl = await acao(() => convertQuote(fd({ id: String(quoteId) })));
    const resId = Number(convUrl.split("?")[0].split("/").pop());
    const item = await um(`SELECT * FROM reservation_items WHERE reservation_id = ?`, [resId]);
    assert.equal(item.pricing_mode, "diaria", "conversão não reprica a modalidade negociada");
    assert.equal(item.period_qty, 3);
    assert.equal(item.subtotal_cents, 4 * 3 * 2000);
    const q = await um(`SELECT status, reservation_id FROM quotes WHERE id = ?`, [quoteId]);
    assert.equal(q.status, "convertido");
  });
});
