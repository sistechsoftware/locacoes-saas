/**
 * DISPONIBILIDADE DOS PROXIMOS 14 DIAS (ficha do produto).
 *
 * Regra provada aqui: cada celula do calendario e um DIA DE CALENDARIO no fuso
 * do negocio — [00:00 do dia, 00:00 do dia seguinte) — e o numero e o PICO de
 * ocupacao daquele dia (o mesmo peakUsage de toda consulta de estoque), nunca
 * a sobra de um horario isolado. Kits continuam derivados dos componentes.
 *
 * O defeito que originou esta suite: a serie repetia a CONSULTA deslocada em
 * +1 dia. Como o filtro da tela e pontual por padrao (uma data e um horario,
 * sem "ate"), a janela tinha duracao zero e cada celula virava a
 * disponibilidade do instante em que a pagina foi aberta — uma reserva das
 * 13:00 as 17:00 sumia de uma consulta aberta as 18:00 e o mesmo dia mostrava
 * numeros diferentes conforme a hora da visita.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1";
import { criarReserva, montarCenario, resetSequencia } from "./helpers/fixtures";
import { run } from "../src/lib/db";
import { setSettings } from "../src/lib/settings";
import { availabilityFor, availabilityForDays } from "../src/lib/stock";

let c: Awaited<ReturnType<typeof montarCenario>>;
beforeEach(async () => {
  createTestDb();
  resetSequencia();
  c = await montarCenario(20, 80); // kit = 1 mesa + 4 cadeiras -> 20 kits
});

const hoje = { considerPreparation: false };
const serie = (productId: number, startDate: string, days = 14) =>
  availabilityForDays(productId, startDate, days, hoje);
const valor = async (productId: number, startDate: string, days = 1) =>
  (await serie(productId, startDate, days))[0].available;
const reserva = (linhas: { product_id: number; qty: number }[], status: string, from: string, to: string) =>
  criarReserva(c.clienteId, linhas, status, { from, to });

describe("produto sem nenhuma reserva", () => {
  it("14 dias inteiramente livres, kit pela composicao e simples pelo estoque", async () => {
    const kit = await serie(c.kitId, "2026-10-10");
    assert.equal(kit.length, 14);
    assert.deepEqual(kit.map((d) => d.available), Array(14).fill(20));
    assert.equal(kit[0].kind, "kit");
    assert.equal(kit[0].total, 0, "kit nao tem estoque proprio");
    assert.equal(await valor(c.mesaId, "2026-10-10"), 20);
    assert.equal(await valor(c.cadeiraId, "2026-10-10"), 80);
  });
});

describe("uma reserva", () => {
  it("ocupa o dia da entrega e o dia da devolucao, e libera no dia seguinte", async () => {
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-10T13:00", "2026-10-11T13:00");

    assert.deepEqual((await serie(c.kitId, "2026-10-10", 3)).map((d) => d.available), [15, 15, 20]);
    assert.deepEqual((await serie(c.mesaId, "2026-10-10", 3)).map((d) => d.available), [15, 15, 20]);
    assert.deepEqual((await serie(c.cadeiraId, "2026-10-10", 3)).map((d) => d.available), [60, 60, 80]);
  });

  it("uma reserva que termina a meia-noite conta no dia que termina, nao no seguinte", async () => {
    await reserva([{ product_id: c.kitId, qty: 2 }], "confirmada", "2026-10-10T20:00", "2026-10-11T00:00");
    assert.deepEqual((await serie(c.kitId, "2026-10-10", 3)).map((d) => d.available), [18, 20, 20]);
  });

  it("uma reserva de madrugada conta no dia em que acontece", async () => {
    await reserva([{ product_id: c.kitId, qty: 3 }], "confirmada", "2026-10-10T00:00", "2026-10-10T05:00");
    assert.deepEqual((await serie(c.kitId, "2026-10-10", 2)).map((d) => d.available), [17, 20]);
  });
});

describe("varias reservas no mesmo dia", () => {
  it("sem sobreposicao, o dia vale o PICO e nao a soma das reservas", async () => {
    createTestDb();
    resetSequencia();
    c = await montarCenario(10, 40); // 10 kits
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-10T08:00", "2026-10-10T10:00");
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-10T14:00", "2026-10-10T16:00");

    assert.equal(await valor(c.kitId, "2026-10-10"), 5, "as duas reservas nao se somam: cada uma usa 5 por vez");
    const as12 = await availabilityFor(c.kitId, "2026-10-10T12:00", "2026-10-10T12:00", null, hoje);
    assert.equal(as12.available, 10, "as 12:00 nao ha ocupacao nenhuma");
  });

  it("sobrepostas somam no pico do dia", async () => {
    createTestDb();
    resetSequencia();
    c = await montarCenario(10, 40);
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-10T09:00", "2026-10-10T12:00");
    await reserva([{ product_id: c.kitId, qty: 3 }], "confirmada", "2026-10-10T10:00", "2026-10-10T11:00");

    assert.equal(await valor(c.kitId, "2026-10-10"), 2, "5 + 3 simultaneos de 10");
    assert.equal(await valor(c.kitId, "2026-10-11"), 10);
  });

  it("reservas em dias consecutivos reaproveitam o mesmo estoque", async () => {
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-10T08:00", "2026-10-10T18:00");
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-11T08:00", "2026-10-11T18:00");

    assert.deepEqual((await serie(c.kitId, "2026-10-10", 3)).map((d) => d.available), [15, 15, 20]);
  });
});

describe("status que comprometem o estoque (regra atual do Locô)", () => {
  for (const status of ["pre_reserva", "confirmada", "entregue", "em_uso", "aguardando_retirada"]) {
    it(`${status} ocupa`, async () => {
      createTestDb();
      resetSequencia();
      c = await montarCenario(20, 80);
      await reserva([{ product_id: c.kitId, qty: 5 }], status, "2026-10-10T09:00", "2026-10-10T18:00");
      assert.equal(await valor(c.kitId, "2026-10-10"), 15);
    });
  }
  for (const status of ["orcamento", "cancelada", "retirada", "finalizada"]) {
    it(`${status} nao ocupa`, async () => {
      createTestDb();
      resetSequencia();
      c = await montarCenario(20, 80);
      await reserva([{ product_id: c.kitId, qty: 5 }], status, "2026-10-10T09:00", "2026-10-10T18:00");
      assert.equal(await valor(c.kitId, "2026-10-10"), 20);
    });
  }

  it("cancelar uma reserva devolve o dia inteiro", async () => {
    const id = await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-10T09:00", "2026-10-10T18:00");
    assert.equal(await valor(c.kitId, "2026-10-10"), 15);
    await run(`UPDATE reservations SET status = 'cancelada' WHERE id = ?`, [id]);
    assert.equal(await valor(c.kitId, "2026-10-10"), 20);
  });
});

describe("kits, componentes e estoque compartilhado", () => {
  it("estoques diferentes mudam a capacidade sem nunca exceder o fisico", async () => {
    for (const [mesas, cadeiras, esperado] of [
      [12, 48, 12],
      [30, 120, 30],
      [20, 60, 15],
      [20, 70, 17],
    ]) {
      createTestDb();
      resetSequencia();
      c = await montarCenario(mesas, cadeiras);
      assert.equal(await valor(c.kitId, "2026-10-10"), esperado, `${mesas} mesas / ${cadeiras} cadeiras`);
    }
  });

  it("kit com varios componentes e limitado pelo mais escasso", async () => {
    createTestDb();
    resetSequencia();
    c = await montarCenario(20, 60); // 15 kits pelas cadeiras
    await reserva([{ product_id: c.kitId, qty: 2 }], "confirmada", "2026-10-10T09:00", "2026-10-10T18:00");

    assert.equal(await valor(c.kitId, "2026-10-10"), 13);
    assert.equal(await valor(c.mesaId, "2026-10-10"), 18);
    assert.equal(await valor(c.cadeiraId, "2026-10-10"), 52);
  });

  it("duas reservas com componentes compartilhados nao duplicam nem subtraem duas vezes", async () => {
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-10T09:00", "2026-10-10T18:00");
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-10T09:00", "2026-10-10T18:00");

    assert.equal(await valor(c.kitId, "2026-10-10"), 10, "10 kits montaveis");
    assert.equal(await valor(c.mesaId, "2026-10-10"), 10, "10 mesas (uma por kit)");
    assert.equal(await valor(c.cadeiraId, "2026-10-10"), 40, "40 cadeiras (quatro por kit)");
  });

  it("kit e avulso do mesmo componente dividem o estoque sem contar em dobro", async () => {
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-10T09:00", "2026-10-10T18:00");
    await reserva([{ product_id: c.mesaId, qty: 8 }], "confirmada", "2026-10-10T09:00", "2026-10-10T18:00");

    assert.equal(await valor(c.mesaId, "2026-10-10"), 7, "5 do kit + 8 avulsas de 20 mesas");
    assert.equal(await valor(c.cadeiraId, "2026-10-10"), 60, "cadeiras so do kit");
    assert.equal(await valor(c.kitId, "2026-10-10"), 7, "limitado pelas mesas: min(7, 15)");
  });
});

describe("limites de periodo e viradas de calendario", () => {
  it("virada de mes", async () => {
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-31T10:00", "2026-11-01T10:00");
    assert.deepEqual((await serie(c.kitId, "2026-10-30", 4)).map((d) => d.available), [20, 15, 15, 20]);
  });

  it("virada de ano", async () => {
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-12-31T10:00", "2027-01-01T10:00");
    assert.deepEqual((await serie(c.kitId, "2026-12-30", 4)).map((d) => d.available), [20, 15, 15, 20]);
  });

  it("consulta dos proximos 14 dias enxerga o 14o dia e ignora o 15o", async () => {
    await reserva([{ product_id: c.kitId, qty: 4 }], "confirmada", "2026-10-23T09:00", "2026-10-23T18:00");
    await reserva([{ product_id: c.kitId, qty: 6 }], "confirmada", "2026-10-24T09:00", "2026-10-24T18:00");

    const dias = await serie(c.kitId, "2026-10-10", 14);
    assert.equal(dias.length, 14);
    assert.equal(dias[12].available, 20, "22/10 ainda livre");
    assert.equal(dias[13].available, 16, "23/10 e o 14o dia da serie: 20 - 4");
    assert.equal(await valor(c.kitId, "2026-10-24"), 14, "24/10 (15o dia) fica fora da serie");
  });
});

describe("nunca negativo indevidamente e nunca acima do estoque", () => {
  it("overbooking de kit fica em zero (nao negativo) e nao inventa unidades", async () => {
    await reserva([{ product_id: c.kitId, qty: 25 }], "confirmada", "2026-10-10T09:00", "2026-10-10T18:00");

    const dias = await serie(c.kitId, "2026-10-10", 3);
    assert.deepEqual(dias.map((d) => d.available), [0, 20, 20]);
    for (const d of dias) assert.ok(d.available >= 0 && d.available <= 20, "entre 0 e a capacidade fisica");

    // O produto simples mostra o excesso como numero negativo (sinal de
    // conflito real); a tela exibe Math.max(0, ...). Nunca acima do total.
    const mesa = await serie(c.mesaId, "2026-10-10", 1);
    assert.equal(mesa[0].available, -5);
    assert.ok(mesa[0].available <= mesa[0].total);
  });

  it("a serie nunca devolve numero acima do estoque cadastrado", async () => {
    await reserva([{ product_id: c.kitId, qty: 7 }], "confirmada", "2026-10-10T09:00", "2026-10-10T18:00");
    for (const d of await serie(c.kitId, "2026-10-10", 14)) assert.ok(d.available <= 20);
    for (const d of await serie(c.mesaId, "2026-10-10", 14)) assert.ok(d.available <= 20);
    for (const d of await serie(c.cadeiraId, "2026-10-10", 14)) assert.ok(d.available <= 80);
  });
});

describe("preparacao (deslocamento/higienizacao)", () => {
  it("preparacao que atravessa a meia-noite ocupa o inicio do dia seguinte", async () => {
    await setSettings({ stock_preparation_minutes: "120" });
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-10T20:00", "2026-10-10T23:00");

    const dias = await availabilityForDays(c.kitId, "2026-10-10", 3, { considerPreparation: true });
    assert.deepEqual(dias.map((d) => d.available), [15, 15, 20], "libera as 01:00 do dia 11");
    const semPreparo = await serie(c.kitId, "2026-10-10", 3);
    assert.deepEqual(semPreparo.map((d) => d.available), [15, 20, 20]);
  });
});

describe("o numero e do DIA, nao do instante da consulta", () => {
  it("reserva das 07:30 as 17:00 zera o dia mesmo para quem consulta as 18:00", async () => {
    await reserva([{ product_id: c.kitId, qty: 5 }], "confirmada", "2026-10-10T07:30", "2026-10-10T17:00");

    const as18 = await availabilityFor(c.kitId, "2026-10-10T18:00", "2026-10-10T18:00", null, hoje);
    assert.equal(as18.available, 20, "as 18:00 a reserva ja terminou: consulta pontual mostra 20");
    assert.equal(await valor(c.kitId, "2026-10-10"), 15, "o calendario mostra o pico do dia: 20 - 5");
  });

  it("a serie de um dia bate com a consulta do dia inteiro nas duas visoes (simples e kit)", async () => {
    await reserva([{ product_id: c.kitId, qty: 3 }], "confirmada", "2026-10-10T10:00", "2026-10-10T14:00");
    await reserva([{ product_id: c.mesaId, qty: 2 }], "confirmada", "2026-10-10T18:00", "2026-10-10T20:00");

    for (const id of [c.kitId, c.mesaId, c.cadeiraId]) {
      const dia = await availabilityFor(id, "2026-10-10T00:00", "2026-10-11T00:00", null, hoje);
      assert.equal((await serie(id, "2026-10-10", 1))[0].available, dia.available);
    }
  });
});
