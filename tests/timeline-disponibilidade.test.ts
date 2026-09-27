/**
 * Timeline de disponibilidade (visao de hotelaria).
 *
 * A timeline e apenas LEITURA: as ocupacoes vem do motor de estoque
 * (loadHolds) e as fases visuais sao derivadas das operacoes agendadas. Estes
 * testes garantem que ela nunca contradiz o motor e que os estados aparecem
 * nos instantes certos.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1";
import { criarReserva, montarCenario, resetSequencia } from "./helpers/fixtures";
import { run, insert } from "../src/lib/db";
import { equipmentTimeline } from "../src/lib/timeline";
import { availabilityTimeline, availabilityFor, type Hold } from "../src/lib/stock";
import { setSettings } from "../src/lib/settings";

const DIA = "2026-09-15";
let c: Awaited<ReturnType<typeof montarCenario>>;
beforeEach(async () => { createTestDb(); resetSequencia(); c = await montarCenario(5, 20); });

const janela = (hIni: string, hFim: string) => ({ from: `${DIA}T${hIni}`, to: `${DIA}T${hFim}` });

async function operacao(reservationId: number, kind: string, status: string, scheduledAt: string) {
  await insert(`INSERT INTO operations (kind, reservation_id, scheduled_at, status) VALUES (?,?,?,?)`, [
    kind, reservationId, scheduledAt, status,
  ]);
}

const linhaDe = (rows: Awaited<ReturnType<typeof equipmentTimeline>>, id: number) =>
  rows.find((r) => r.product_id === id)!;

const faseEm = (row: ReturnType<typeof linhaDe>, t: string): string | null => {
  for (const lane of row.lanes) {
    const b = lane.blocks.find((x) => x.from <= t && x.to > t);
    if (b) return b.phase;
  }
  return null;
};

describe("timeline de produto fisico", () => {
  it("sem reservas, nenhum bloco e faixa inteiramente livre", async () => {
    const rows = await equipmentTimeline(`${DIA}T00:00`, `${DIA}T23:59`);
    const mesa = linhaDe(rows, c.mesaId);
    assert.equal(mesa.lanes.length, 0);
    assert.equal(mesa.lanesTotal, 0);
    assert.equal(mesa.faixa.length, 1);
    assert.equal(mesa.faixa[0].available, 5);
    assert.equal(mesa.peak_used, 0);
  });

  it("uma reserva ocupa uma pista e a faixa mostra o degrau de liberacao", async () => {
    const id = await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 2 }], "confirmada", janela("10:00", "14:00"));
    const rows = await equipmentTimeline(`${DIA}T08:00`, `${DIA}T18:00`);
    const mesa = linhaDe(rows, c.mesaId);

    // 2 unidades -> 2 pistas
    assert.equal(mesa.lanesTotal, 2);
    for (const lane of mesa.lanes) assert.equal(lane.blocks.length, 1);
    assert.equal(mesa.lanes[0].blocks[0].reservationId, id);

    // faixa: 5 livres antes das 10, 3 livres entre 10 e 14, 5 depois
    const degraus = Object.fromEntries(mesa.faixa.map((f) => [f.from, f.available]));
    assert.equal(degraus[`${DIA}T08:00`], 5);
    assert.equal(degraus[`${DIA}T10:00`], 3);
    assert.equal(degraus[`${DIA}T14:00`], 5);
  });

  it("fase inicial reservado; aguardando devolucao apos a retirada marcada", async () => {
    const id = await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 1 }], "confirmada", janela("10:00", "18:00"));
    await operacao(id, "retirada", "pendente", `${DIA}T16:00`);
    const mesa = linhaDe(await equipmentTimeline(`${DIA}T08:00`, `${DIA}T22:00`), c.mesaId);

    assert.equal(faseEm(mesa, `${DIA}T10:30`), "reservado");
    assert.equal(faseEm(mesa, `${DIA}T15:59`), "reservado");
    assert.equal(faseEm(mesa, `${DIA}T16:30`), "aguardando");
  });

  it("entrega concluida muda a fase para em uso a partir da hora da entrega", async () => {
    const id = await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 1 }], "confirmada", janela("10:00", "18:00"));
    await operacao(id, "entrega", "concluida", `${DIA}T11:00`);
    const mesa = linhaDe(await equipmentTimeline(`${DIA}T08:00`, `${DIA}T22:00`), c.mesaId);

    assert.equal(faseEm(mesa, `${DIA}T10:30`), "reservado");
    assert.equal(faseEm(mesa, `${DIA}T12:00`), "em_uso");
  });

  it("entrega em rota pinta o comeco como transporte", async () => {
    const id = await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 1 }], "confirmada", janela("10:00", "18:00"));
    await operacao(id, "entrega", "em_rota", `${DIA}T10:00`);
    const mesa = linhaDe(await equipmentTimeline(`${DIA}T08:00`, `${DIA}T22:00`), c.mesaId);

    assert.equal(faseEm(mesa, `${DIA}T10:30`), "transporte");
  });

  it("status em_uso e aguardando_retirada definem a fase sem operacao agendada", async () => {
    await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 1 }], "em_uso", janela("10:00", "18:00"));
    await criarReserva(c.clienteId, [{ product_id: c.cadeiraId, qty: 4 }], "aguardando_retirada", janela("10:00", "18:00"));
    const rows = await equipmentTimeline(`${DIA}T08:00`, `${DIA}T22:00`);
    assert.equal(faseEm(linhaDe(rows, c.mesaId), `${DIA}T12:00`), "em_uso");
    assert.equal(faseEm(linhaDe(rows, c.cadeiraId), `${DIA}T12:00`), "aguardando");
  });

  it("preparo (higienizacao) aparece apos o fim da janela quando configurado", async () => {
    await setSettings({ stock_preparation_minutes: "120" });
    await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 1 }], "confirmada", janela("10:00", "14:00"));
    const mesa = linhaDe(await equipmentTimeline(`${DIA}T08:00`, `${DIA}T22:00`), c.mesaId);

    assert.equal(faseEm(mesa, `${DIA}T13:59`), "reservado");
    assert.equal(faseEm(mesa, `${DIA}T14:30`), "preparo");
    assert.equal(faseEm(mesa, `${DIA}T15:59`), "preparo");
    // intervalos sao fim-exclusivos: as 16:00 (14:00 + 120min) ja liberou
    assert.equal(faseEm(mesa, `${DIA}T16:00`), null);
  });

  it("preparo desativado: nada e pintado depois do fim da janela", async () => {
    await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 1 }], "confirmada", janela("10:00", "14:00"));
    const mesa = linhaDe(await equipmentTimeline(`${DIA}T08:00`, `${DIA}T22:00`, { considerPreparation: false }), c.mesaId);
    assert.equal(faseEm(mesa, `${DIA}T14:30`), null);
  });

  it("reservas simultaneas empilham pistas; sequenciais reaproveitam a mesma pista", async () => {
    await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 1 }], "confirmada", janela("08:00", "10:00"));
    await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 1 }], "confirmada", janela("12:00", "14:00"));
    await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 2 }], "confirmada", janela("09:00", "11:00"));
    const mesa = linhaDe(await equipmentTimeline(`${DIA}T00:00`, `${DIA}T23:59`), c.mesaId);

    // pico: 1 (08-10) + 2 (09-11) = 3 simultaneas
    assert.equal(mesa.lanesTotal, 3);
    assert.equal(mesa.peak_used, 3);
    assert.equal(mesa.lanes.length, 3); // limite de exibicao (4) nao corta
  });

  it("janela parcial: ocupacao que comeca antes da consulta e cortada na borda", async () => {
    await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 1 }], "confirmada", {
      from: "2026-09-14T20:00", to: `${DIA}T10:00`,
    });
    const mesa = linhaDe(await equipmentTimeline(`${DIA}T08:00`, `${DIA}T12:00`), c.mesaId);
    const b = mesa.lanes[0].blocks[0];
    assert.equal(b.from, `${DIA}T08:00`);
    assert.equal(b.to, `${DIA}T10:00`);
    assert.equal(mesa.faixa[0].from, `${DIA}T08:00`);
    assert.equal(mesa.faixa[0].available, 4);
  });

  it("reserva cancelada nao aparece na timeline", async () => {
    const id = await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 2 }], "confirmada", janela("10:00", "14:00"));
    await run(`UPDATE reservations SET status = 'cancelada' WHERE id = ?`, [id]);
    const mesa = linhaDe(await equipmentTimeline(`${DIA}T00:00`, `${DIA}T23:59`), c.mesaId);
    assert.equal(mesa.lanesTotal, 0);
    assert.equal(mesa.faixa.length, 1);
    assert.equal(mesa.faixa[0].available, 5);
  });

  it("modo apenasOcupados esconde equipamentos livres", async () => {
    await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 1 }], "confirmada", janela("10:00", "14:00"));
    const rows = await equipmentTimeline(`${DIA}T00:00`, `${DIA}T23:59`, {}, { apenasOcupados: true });
    assert.ok(rows.some((r) => r.product_id === c.mesaId));
    assert.ok(!rows.some((r) => r.product_id === c.cadeiraId));
    assert.ok(!rows.some((r) => r.product_id === c.kitId));
  });
});

describe("timeline de kits", () => {
  it("kit mostra pistas por item comercial e faixa de kits montaveis", async () => {
    const id = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 2 }], "confirmada", janela("10:00", "14:00"));
    const kit = linhaDe(await equipmentTimeline(`${DIA}T08:00`, `${DIA}T18:00`), c.kitId);

    assert.equal(kit.kind, "kit");
    assert.equal(kit.lanesTotal, 2); // 2 kits contratados -> 2 pistas (uma por kit)
    assert.equal(kit.lanes[0].blocks[0].reservationId, id);

    // capacidade estatica: min(floor(5/1), floor(20/4)) = 5
    assert.equal(kit.effective, 5);
    // pico: 2 kits ocupados -> 3 montaveis restantes
    const degrau = kit.faixa.find((f) => f.from === `${DIA}T10:00`);
    assert.equal(degrau?.available, 3);
    assert.equal(kit.peak_used, 2);
  });

  it("kit e produto simples nao duplicam: uso comercial so no kit, fisico so no simples", async () => {
    await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 2 }], "confirmada", janela("10:00", "14:00"));
    const rows = await equipmentTimeline(`${DIA}T08:00`, `${DIA}T18:00`);
    const kit = linhaDe(rows, c.kitId);
    const mesa = linhaDe(rows, c.mesaId);

    assert.equal(kit.lanesTotal, 2); // 2 kits contratados
    // mesas continuam mostrando o consumo fisico das 2 mesas
    assert.equal(mesa.lanesTotal, 2);
    assert.equal(mesa.peak_used, 2);
  });

  it("reserva mista (kit + avulso) gera pistas separadas por produto", async () => {
    await criarReserva(c.clienteId, [
      { product_id: c.kitId, qty: 1 },
      { product_id: c.mesaId, qty: 1 },
    ], "confirmada", janela("10:00", "14:00"));
    const rows = await equipmentTimeline(`${DIA}T08:00`, `${DIA}T18:00`);
    assert.equal(linhaDe(rows, c.kitId).lanesTotal, 1);
    // 1 do kit + 1 avulsa = 2 pistas de mesa
    assert.equal(linhaDe(rows, c.mesaId).lanesTotal, 2);
  });
});

describe("coerencia com o motor de disponibilidade", () => {
  it("a faixa da timeline bate com availabilityTimeline em todos os degraus", async () => {
    await setSettings({ stock_preparation_minutes: "60" });
    await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 2 }], "confirmada", janela("10:00", "14:00"));
    await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 1 }], "confirmada", janela("12:00", "16:00"));

    const from = `${DIA}T08:00`, to = `${DIA}T20:00`;
    const mesa = linhaDe(await equipmentTimeline(from, to), c.mesaId);
    const holds: Hold[] = [
      { reservation_id: 1, number: "LIMA-001", customer: "Cliente", status: "confirmada", qty: 2, hold_start: `${DIA}T10:00`, hold_end: `${DIA}T15:00` },
      { reservation_id: 2, number: "LIMA-002", customer: "Cliente", status: "confirmada", qty: 1, hold_start: `${DIA}T12:00`, hold_end: `${DIA}T17:00` },
    ];
    const motor = availabilityTimeline(holds, 5, from, to);

    assert.equal(mesa.faixa.length, motor.length);
    for (let i = 0; i < motor.length; i++) {
      assert.equal(mesa.faixa[i].from, motor[i].from);
      assert.equal(mesa.faixa[i].to, motor[i].to);
      assert.equal(mesa.faixa[i].available, motor[i].available);
    }
  });

  it("o pico da timeline nao excede a disponibilidade reportada pelo motor", async () => {
    await criarReserva(c.clienteId, [{ product_id: c.mesaId, qty: 3 }], "confirmada", janela("10:00", "14:00"));
    const from = `${DIA}T10:00`, to = `${DIA}T10:00`;
    const mesa = linhaDe(await equipmentTimeline(from, to), c.mesaId);
    const consulta = await availabilityFor(c.mesaId, from, to, null, { considerPreparation: false });
    assert.equal(mesa.peak_used, consulta.reserved);
  });
});
