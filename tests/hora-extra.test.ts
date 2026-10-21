/**
 * HORA EXTRA NA EXTENSÃO DE RETIRADA.
 *
 * Duas camadas, ambas com SQLite real e migrations reais (tests/helpers/d1.ts):
 *   1. REGRA PURA (lib/hora-extra.ts): horas cheias por extensão menor que o
 *      limite, acima do limite nada é cobrado, extensão que soma diária de
 *      calendário não gera dupla cobrança, recurso desligado não cobra nada.
 *   2. ACTIONS REAIS: updateReservation/updateQuote calculam a extensão no
 *      SERVIDOR comparando a retirada gravada com a nova (o cliente não envia
 *      valor), gravam extension_minutes/extension_cents e o recalc soma a
 *      extensão no total. Retirada não alterada preserva o já combinado.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* Scaffold do Next: as actions importam next/*, que exige o runtime. */
const SESSAO = "sess-hora-extra";
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
function diaFuturo(dias: number): string {
  return new Date(Date.now() + dias * 864e5).toISOString().slice(0, 10);
}
const DIA = diaFuturo(10);
const DIA1 = diaFuturo(11);
const DIA2 = diaFuturo(12);
const PRODUTO = 500;

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
const run = async (s: string, p: any[] = []) => (await import("../src/lib/db.ts")).run(s, p);

const centavos = (c: number | null | undefined) => ((c ?? 0) / 100).toFixed(2);
const ITENS = JSON.stringify([{ product_id: PRODUTO, qty: 2, unit_price_cents: 5000, discount_cents: 0 }]);

/** Cabeçalho completo a partir da linha gravada (readHeader refaz tudo do fd). */
function fdReserva(r: any, extra: Record<string, string> = {}): FormData {
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
    needs_assembly: r.needs_assembly ? "1" : "",
    needs_disassembly: r.needs_disassembly ? "1" : "",
    freight: centavos(r.freight_cents),
    assembly: centavos(r.assembly_cents),
    disassembly: centavos(r.disassembly_cents),
    other: centavos(r.other_cents),
    discount: centavos(r.discount_cents),
    notes: r.notes ?? "",
    status: r.status,
    deposit: centavos(0),
    items: ITENS,
    ...extra,
  });
}

before(async () => {
  const { createTestDb, resetTestDb } = await import("./helpers/d1.ts");
  resetTestDb();
  createTestDb();
  await run(`UPDATE companies SET name = 'Empresa Hora Extra' WHERE id = 1`);
  await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0)`);
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active)
     VALUES (10, 'Dono', 'dono-hora-extra', 'x', 'owner', 1, 1)`,
  );
  await run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, 10, ?)`, [SESSAO, FUTURO]);
  await run(`INSERT INTO customers (id, name, phone, company_id) VALUES (1, 'Cliente Hora', '31999990000', 1)`);
  await run(
    `INSERT INTO products (id, code, name, kind, total_qty, company_id)
     VALUES (${PRODUTO}, 'MESA-HR', 'Mesa', 'simples', 10, 1)`,
  );
  // Regra da empresa: R$ 30,00/hora; vira negociação a partir de 6h.
  await run(`INSERT INTO company_settings (company_id, key, value) VALUES (1, 'extra_hour_price_cents', '3000')`);
  await run(`INSERT INTO company_settings (company_id, key, value) VALUES (1, 'extra_hours_until_daily', '6')`);
});

/* ------------------------------------------------------------------ */
/* 1. Regra pura                                                       */
/* ------------------------------------------------------------------ */

describe("calcularExtensao — regra", () => {
  const base = { deliveryAnterior: `${DIA}T08:00`, deliveryNovo: `${DIA}T08:00`, precoHoraCents: 3000, limiteHoras: 6 };

  it("cobra horas cheias abaixo do limite (3h → R$ 90)", async () => {
    const { calcularExtensao } = await carregar("src/lib/hora-extra.ts");
    const r = calcularExtensao({ ...base, pickupAnterior: `${DIA1}T08:00`, pickupNovo: `${DIA1}T11:00` });
    assert.equal(r.minutos, 180);
    assert.equal(r.horasCobradas, 3);
    assert.equal(r.cents, 9000);
    assert.equal(r.acimaDoLimite, false);
  });

  it("45 minutos arredonda para 1 hora cheia", async () => {
    const { calcularExtensao } = await carregar("src/lib/hora-extra.ts");
    const r = calcularExtensao({ ...base, pickupAnterior: `${DIA1}T08:00`, pickupNovo: `${DIA1}T08:45` });
    assert.equal(r.horasCobradas, 1);
    assert.equal(r.cents, 3000);
  });

  it("igual ou maior que o limite não cobra e sinaliza acimaDoLimite", async () => {
    const { calcularExtensao } = await carregar("src/lib/hora-extra.ts");
    const r = calcularExtensao({ ...base, pickupAnterior: `${DIA1}T08:00`, pickupNovo: `${DIA1}T14:00` });
    assert.equal(r.cents, 0);
    assert.equal(r.acimaDoLimite, true);
  });

  it("retirada igual ou anterior não cobra nada", async () => {
    const { calcularExtensao } = await carregar("src/lib/hora-extra.ts");
    const igual = calcularExtensao({ ...base, pickupAnterior: `${DIA1}T08:00`, pickupNovo: `${DIA1}T08:00` });
    const anterior = calcularExtensao({ ...base, pickupAnterior: `${DIA1}T08:00`, pickupNovo: `${DIA1}T06:00` });
    assert.equal(igual.cents, 0);
    assert.equal(anterior.cents, 0);
  });

  it("extensão que soma diária de calendário não gera dupla cobrança", async () => {
    const { calcularExtensao } = await carregar("src/lib/hora-extra.ts");
    // entrega DIA, retirada DIA1 22:00 (1 diária) → estender para DIA2 01:00
    // soma a 2ª diária no recálculo do período: a hora extra fica de fora.
    const r = calcularExtensao({ ...base, pickupAnterior: `${DIA1}T22:00`, pickupNovo: `${DIA2}T01:00` });
    assert.equal(r.cents, 0);
    assert.equal(r.minutos, 0);
  });

  it("recurso desligado (preço 0 ou limite 0) não cobra nada", async () => {
    const { calcularExtensao } = await carregar("src/lib/hora-extra.ts");
    const semPreco = calcularExtensao({ ...base, precoHoraCents: 0, pickupAnterior: `${DIA1}T08:00`, pickupNovo: `${DIA1}T11:00` });
    const semLimite = calcularExtensao({ ...base, limiteHoras: 0, pickupAnterior: `${DIA1}T08:00`, pickupNovo: `${DIA1}T11:00` });
    assert.equal(semPreco.cents, 0);
    assert.equal(semLimite.cents, 0);
  });

  it("rotuloExtensao formata +3h e +3h30", async () => {
    const { rotuloExtensao } = await carregar("src/lib/hora-extra.ts");
    assert.equal(rotuloExtensao(180), "+3h");
    assert.equal(rotuloExtensao(210), "+3h30");
    assert.equal(rotuloExtensao(45), "+0h45");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Actions reais                                                    */
/* ------------------------------------------------------------------ */

describe("updateReservation — extensão cobrada no servidor", () => {
  let reservaId = 0;

  it("criar reserva não tem extensão e o total é o de sempre", async () => {
    const { createReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    const url = await acao(() =>
      createReservation(
        null,
        fd({
          customer_id: "1",
          event_date: DIA,
          event_time: "",
          address: "",
          district: "",
          city: "",
          delivery_at: `${DIA}T08:00`,
          pickup_at: `${DIA1}T08:00`,
          needs_delivery: "1",
          needs_pickup: "1",
          freight: "",
          assembly: "",
          disassembly: "",
          other: "",
          discount: "",
          notes: "",
          status: "confirmada",
          deposit: "0",
          items: ITENS,
        }),
      ),
    );
    reservaId = Number(url.split("/").pop());
    assert.ok(reservaId > 0, `redirect inesperado: ${url}`);
    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    assert.equal(r.extension_minutes, 0);
    assert.equal(r.extension_cents, 0);
    assert.equal(r.total_cents, 10000, "total histórico: 2 × R$ 50,00, sem período");
  });

  it("estender a retirada em 3h cobra 3 × R$ 30 e entra no total", async () => {
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    const atual = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    await acao(() => updateReservation(null, fdReserva(atual, { pickup_at: `${DIA1}T11:00` })));
    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    assert.equal(r.extension_minutes, 180);
    assert.equal(r.extension_cents, 9000);
    assert.equal(r.total_cents, 19000, "itens R$ 100 + extensão R$ 90");
    // a retirada da agenda operacional acompanha a nova janela
    const ops = await um(`SELECT scheduled_at FROM operations WHERE reservation_id = ? AND kind = 'retirada'`, [reservaId]);
    assert.equal(ops.scheduled_at, `${DIA1}T11:00`);
  });

  it("salvar sem mexer na retirada preserva a extensão gravada", async () => {
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    const atual = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    await acao(() => updateReservation(null, fdReserva(atual, { notes: "cliente ligou" })));
    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    assert.equal(r.extension_cents, 9000, "reabrir e salvar não apaga o combinado");
    assert.equal(r.total_cents, 19000);
  });

  it("extensão >= limite não cobra nada (negociação do operador)", async () => {
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    const atual = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    // 11:00 → 18:00 = 7h, acima do limite de 6h configurado
    await acao(() => updateReservation(null, fdReserva(atual, { pickup_at: `${DIA1}T18:00` })));
    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    assert.equal(r.extension_minutes, 420);
    assert.equal(r.extension_cents, 0);
    assert.equal(r.total_cents, 10000);
  });

  it("extensão que cruza a meia-noite e soma diária não cobra hora extra", async () => {
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    const atual = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    // 18:00 → 01:00 do dia seguinte: vira 2 dias de calendário (+1 diária no
    // recálculo do período) — a hora extra fica de fora, nada de cobrar duas vezes
    await acao(() => updateReservation(null, fdReserva(atual, { pickup_at: `${DIA2}T01:00` })));
    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    assert.equal(r.extension_cents, 0);
  });

  it("recurso desligado (sem setting) não cobra nada", async () => {
    const { updateReservation } = await carregar("src/app/(app)/reservas/actions.ts");
    await run(`DELETE FROM company_settings WHERE company_id = 1 AND key = 'extra_hour_price_cents'`);
    const atual = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    await acao(() => updateReservation(null, fdReserva(atual, { pickup_at: `${DIA2}T04:00` })));
    const r = await um(`SELECT * FROM reservations WHERE id = ?`, [reservaId]);
    assert.equal(r.extension_cents, 0);
    // religa para os próximos testes
    await run(`INSERT INTO company_settings (company_id, key, value) VALUES (1, 'extra_hour_price_cents', '3000')`);
  });
});

describe("updateQuote — mesma regra no orçamento", () => {
  let quoteId = 0;

  it("estender a retirada do orçamento grava a extensão e o total", async () => {
    const { createQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    const url = await acao(() =>
      createQuote(
        null,
        fd({
          customer_id: "1",
          event_date: DIA,
          event_time: "",
          address: "",
          district: "",
          city: "",
          delivery_at: `${DIA}T08:00`,
          pickup_at: `${DIA1}T08:00`,
          valid_until: "",
          freight: "",
          assembly: "",
          disassembly: "",
          other: "",
          discount: "",
          notes: "",
          status: "rascunho",
          items: ITENS,
        }),
      ),
    );
    quoteId = Number(url.split("/").pop());
    assert.ok(quoteId > 0, `redirect inesperado: ${url}`);

    const { updateQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    const q = await um(`SELECT * FROM quotes WHERE id = ?`, [quoteId]);
    const f = fd({
      id: String(q.id),
      customer_id: String(q.customer_id),
      event_date: q.event_date ?? "",
      event_time: q.event_time ?? "",
      address: q.address ?? "",
      district: q.district ?? "",
      city: q.city ?? "",
      delivery_at: q.delivery_at,
      pickup_at: `${DIA1}T10:00`,
      valid_until: q.valid_until ?? "",
      freight: centavos(q.freight_cents),
      assembly: centavos(q.assembly_cents),
      disassembly: centavos(q.disassembly_cents),
      other: centavos(q.other_cents),
      discount: centavos(q.discount_cents),
      notes: q.notes ?? "",
      status: q.status,
      items: ITENS,
    });
    await acao(() => updateQuote(null, f));
    const r = await um(`SELECT * FROM quotes WHERE id = ?`, [quoteId]);
    assert.equal(r.extension_minutes, 120);
    assert.equal(r.extension_cents, 6000);
    assert.equal(r.total_cents, 16000, "itens R$ 100 + extensão R$ 60");
  });

  it("conversão em reserva herda a extensão gravada", async () => {
    const { convertQuote } = await carregar("src/app/(app)/orcamentos/actions.ts");
    const q = await um(`SELECT * FROM quotes WHERE id = ?`, [quoteId]);
    const f = new FormData();
    f.set("id", String(q.id));
    // janela livre de conflito: mesmas datas do orçamento
    await acao(async () => {
      try {
        await convertQuote(f);
      } catch (e: any) {
        // convertQuote redireciona com erro de conflito via querystring
        if (String(e?.message ?? e).startsWith("NEXT_REDIRECT:") && String(e.message).includes("erro=")) throw e;
        throw e;
      }
    });
    const r = await um(`SELECT * FROM reservations WHERE quote_id = ?`, [quoteId]);
    assert.ok(r, "reserva criada a partir do orçamento");
    assert.equal(r.extension_minutes, 120);
    assert.equal(r.extension_cents, 6000);
  });
});
