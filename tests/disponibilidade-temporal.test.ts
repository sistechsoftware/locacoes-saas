/**
 * Linha do tempo da disponibilidade.
 *
 * O motor ja respondia corretamente "cabe nesta janela?" pelo pico de uso.
 * O que faltava era mostrar QUANDO o equipamento libera dentro do dia: uma
 * consulta ao dia inteiro devolvia zero mesmo havendo devolucao ao meio-dia.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { availabilityTimeline, disponivelAPartirDe, peakUsage, type Hold } from "../src/lib/stock.ts";

const hold = (qty: number, from: string, to: string): Hold => ({
  reservation_id: 1,
  number: "LIMA-001",
  customer: "Cliente",
  status: "confirmada",
  qty,
  hold_start: from,
  hold_end: to,
});

const DIA_DE = "2026-09-05T00:00";
const DIA_ATE = "2026-09-05T23:59";

describe("cenario relatado: 11 kits, 5 voltam ao meio-dia", () => {
  // 5 alugados ontem, devolucao hoje 12:00; 6 entregues hoje 10:00, voltam amanha
  const holds = [
    hold(5, "2026-09-04T09:00", "2026-09-05T12:00"),
    hold(6, "2026-09-05T10:00", "2026-09-06T18:00"),
  ];
  const trechos = availabilityTimeline(holds, 11, DIA_DE, DIA_ATE);

  it("o pico do dia continua zero, que e a resposta certa para o dia inteiro", () => {
    assert.equal(11 - peakUsage(holds, DIA_DE, DIA_ATE), 0);
  });

  it("mas a linha do tempo mostra a liberacao ao meio-dia", () => {
    const meioDia = trechos.find((t) => t.from === "2026-09-05T12:00");
    assert.ok(meioDia, "deveria haver um trecho comecando as 12:00");
    assert.equal(meioDia!.available, 5);
  });

  it("entre a entrega das 10:00 e a devolucao das 12:00 nao sobra nada", () => {
    const cheio = trechos.find((t) => t.from === "2026-09-05T10:00");
    assert.ok(cheio, "deveria haver um trecho comecando as 10:00");
    assert.equal(cheio!.available, 0);
  });

  it("de madrugada ate a entrega das 10:00 os 6 ainda estao na base", () => {
    const cedo = trechos.find((t) => t.from === "2026-09-05T00:00");
    assert.equal(cedo?.available, 6);
  });

  it("uma reserva de 5 kits cabe ja de manha, e tambem depois do meio-dia", () => {
    assert.equal(disponivelAPartirDe(trechos, 5), "2026-09-05T00:00");
    const aTarde = trechos.find((t) => t.from === "2026-09-05T12:00");
    assert.ok(aTarde!.available >= 5);
  });

  it("7 kits nunca ficam livres neste dia", () => {
    assert.equal(disponivelAPartirDe(trechos, 7), null);
  });
});

describe("devolucao e nova retirada no mesmo dia", () => {
  const umaDevolucao = (hora: string) => availabilityTimeline([hold(5, "2026-09-04T09:00", hora)], 5, DIA_DE, DIA_ATE);

  it("devolve 12:00 e retira 14:00: disponivel", () => {
    const t = umaDevolucao("2026-09-05T12:00");
    assert.equal(disponivelAPartirDe(t, 5), "2026-09-05T12:00");
    assert.ok("2026-09-05T14:00" >= disponivelAPartirDe(t, 5)!);
  });

  it("devolve 15:00 e retira 14:00: ainda ocupado as 14:00", () => {
    const t = umaDevolucao("2026-09-05T15:00");
    const as14 = t.find((x) => x.from <= "2026-09-05T14:00" && x.to > "2026-09-05T14:00");
    assert.equal(as14?.available, 0);
  });

  it("devolve 12:00 e retira 13:00: disponivel", () => {
    const t = umaDevolucao("2026-09-05T12:00");
    const as13 = t.find((x) => x.from <= "2026-09-05T13:00" && x.to > "2026-09-05T13:00");
    assert.equal(as13?.available, 5);
  });
});

describe("varias devolucoes", () => {
  it("cada devolucao aparece como um degrau", () => {
    const trechos = availabilityTimeline(
      [
        hold(3, "2026-09-04T08:00", "2026-09-05T10:00"),
        hold(4, "2026-09-04T08:00", "2026-09-05T16:00"),
      ],
      10,
      DIA_DE,
      DIA_ATE,
    );
    const em = (h: string) => trechos.find((t) => t.from <= h && t.to > h)?.available;
    assert.equal(em("2026-09-05T09:00"), 3); // 10 - 7
    assert.equal(em("2026-09-05T12:00"), 6); // 10 - 4
    assert.equal(em("2026-09-05T18:00"), 10); // tudo devolvido
  });
});

describe("casos simples", () => {
  it("sem ocupacao, um unico trecho com tudo livre", () => {
    const t = availabilityTimeline([], 8, DIA_DE, DIA_ATE);
    assert.equal(t.length, 1);
    assert.equal(t[0].available, 8);
  });

  it("ocupacao o dia inteiro nao gera degraus", () => {
    const t = availabilityTimeline([hold(8, "2026-09-04T00:00", "2026-09-06T00:00")], 8, DIA_DE, DIA_ATE);
    assert.equal(t.length, 1);
    assert.equal(t[0].available, 0);
  });

  it("trechos vizinhos com a mesma disponibilidade sao unidos", () => {
    // duas reservas que terminam no mesmo instante viram um degrau so
    const t = availabilityTimeline(
      [hold(2, "2026-09-04T08:00", "2026-09-05T12:00"), hold(3, "2026-09-04T08:00", "2026-09-05T12:00")],
      10,
      DIA_DE,
      DIA_ATE,
    );
    assert.equal(t.length, 2);
    assert.equal(t[0].available, 5);
    assert.equal(t[1].available, 10);
  });

  it("ocupacao fora da janela consultada e ignorada", () => {
    const t = availabilityTimeline([hold(5, "2026-09-01T08:00", "2026-09-02T08:00")], 5, DIA_DE, DIA_ATE);
    assert.equal(t.length, 1);
    assert.equal(t[0].available, 5);
  });
});

describe("coerencia com o motor existente", () => {
  it("o pior trecho da linha do tempo bate com o pico de uso", () => {
    const holds = [
      hold(5, "2026-09-04T09:00", "2026-09-05T12:00"),
      hold(6, "2026-09-05T10:00", "2026-09-06T18:00"),
      hold(2, "2026-09-05T14:00", "2026-09-05T20:00"),
    ];
    const trechos = availabilityTimeline(holds, 20, DIA_DE, DIA_ATE);
    const piorTrecho = Math.max(...trechos.map((t) => t.reserved));
    assert.equal(piorTrecho, peakUsage(holds, DIA_DE, DIA_ATE));
  });
});
