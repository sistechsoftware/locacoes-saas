/** Contas a receber de locacoes e fretes, com o SQL real da aplicacao. */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { insert, run, scalar } from "../src/lib/db.ts";
import { gerarRecebiveis, listarEntries, recebiveisDe, totaisEntries } from "../src/lib/receber.ts";

let cliente = 0;

async function cenario() {
  createTestDb();
  cliente = await insert(`INSERT INTO customers (name) VALUES ('Cliente Teste')`);
}

async function locacao(totalCents: number, numero = "LIMA-001") {
  const id = await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, total_cents)
     VALUES (?,?,'confirmada','2026-09-20',?)`,
    [numero, cliente, totalCents],
  );
  return id;
}

async function receber(entryId: number, valorCents: number, data = "2026-09-15") {
  await insert(
    `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, entry_id)
     VALUES (NULL,?, 'pix', ?, ?)`,
    [valorCents, data, entryId],
  );
}

describe("Teste 7 - locacao parcelada", () => {
  beforeEach(cenario);

  it("R$ 1.200 em 4x cria quatro contas a receber", async () => {
    const id = await locacao(120000);
    const erro = await gerarRecebiveis(
      { tipo: "locacao", reservationId: id },
      { parcelas: 4, primeiroVencimento: "2026-09-15" },
    );
    assert.equal(erro, null);

    const parcelas = await recebiveisDe({ tipo: "locacao", reservationId: id });
    assert.equal(parcelas.length, 4);
    assert.ok(parcelas.every((p: any) => p.amount_cents === 30000));
    assert.equal(
      parcelas.reduce((a: number, p: any) => a + p.amount_cents, 0),
      120000,
      "as parcelas somam o contratado",
    );
    assert.ok(parcelas.every((p: any) => p.direction === "receber" && p.origin === "locacao"));
  });

  it("os vencimentos avancam de mes em mes", async () => {
    const id = await locacao(120000);
    await gerarRecebiveis({ tipo: "locacao", reservationId: id }, { parcelas: 4, primeiroVencimento: "2026-09-15" });
    const p = await recebiveisDe({ tipo: "locacao", reservationId: id });
    assert.deepEqual(
      p.map((x: any) => x.due_date),
      ["2026-09-15", "2026-10-15", "2026-11-15", "2026-12-15"],
    );
  });
});

describe("Teste 8 - receber uma parcela", () => {
  beforeEach(cenario);

  it("so o valor recebido entra no caixa", async () => {
    const id = await locacao(120000);
    await gerarRecebiveis({ tipo: "locacao", reservationId: id }, { parcelas: 4, primeiroVencimento: "2026-09-15" });
    const parcelas = await recebiveisDe({ tipo: "locacao", reservationId: id });
    await receber(parcelas[0].id, 30000);

    const emCaixa = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments`);
    assert.equal(emCaixa, 30000, "caixa: R$ 300");

    const totais = await totaisEntries("receber");
    assert.equal(totais.previsto, 120000, "contratado: R$ 1.200");
    assert.equal(totais.liquidado, 30000, "recebido: R$ 300");
    assert.equal(totais.saldo, 90000, "a receber: R$ 900");
  });

  it("a parcela recebida aparece como quitada e as outras em aberto", async () => {
    const id = await locacao(120000);
    await gerarRecebiveis({ tipo: "locacao", reservationId: id }, { parcelas: 4, primeiroVencimento: "2026-12-15" });
    const parcelas = await recebiveisDe({ tipo: "locacao", reservationId: id });
    await receber(parcelas[0].id, 30000);

    const lista = await listarEntries({ direction: "receber" });
    assert.equal(lista.find((e) => e.id === parcelas[0].id)?.situacao, "quitada");
    assert.equal(lista.filter((e) => e.situacao === "aberta").length, 3);
  });
});

describe("Teste 9 - recebimento parcial", () => {
  beforeEach(cenario);

  it("parcela de R$ 500 com R$ 300 recebidos fica parcial", async () => {
    const id = await locacao(50000);
    await gerarRecebiveis({ tipo: "locacao", reservationId: id }, { parcelas: 1, primeiroVencimento: "2026-12-20" });
    const [parcela] = await recebiveisDe({ tipo: "locacao", reservationId: id });
    await receber(parcela.id, 30000);

    const lista = await listarEntries({ direction: "receber" });
    const alvo = lista.find((e) => e.id === parcela.id)!;
    assert.equal(alvo.amount_cents, 50000);
    assert.equal(alvo.liquidado_cents, 30000);
    assert.equal(alvo.saldo_cents, 20000);
    assert.equal(alvo.situacao, "parcial");
  });
});

describe("fretes", () => {
  beforeEach(cenario);

  it("um frete gera a sua propria conta a receber", async () => {
    const freteId = await insert(
      `INSERT INTO freights (number, customer_id, date, amount_cents, status)
       VALUES ('FRT-001',?,'2026-09-12',18000,'agendado')`,
      [cliente],
    );
    await gerarRecebiveis({ tipo: "frete", freightId: freteId }, { parcelas: 1, primeiroVencimento: "2026-09-12" });

    const parcelas = await recebiveisDe({ tipo: "frete", freightId: freteId });
    assert.equal(parcelas.length, 1);
    assert.equal(parcelas[0].amount_cents, 18000);
    assert.equal(parcelas[0].origin, "frete");
  });

  it("receita de locacao e de frete ficam separadas", async () => {
    const loc = await locacao(100000);
    const frete = await insert(
      `INSERT INTO freights (number, customer_id, date, amount_cents, status)
       VALUES ('FRT-002',?,'2026-09-12',20000,'agendado')`,
      [cliente],
    );
    await gerarRecebiveis({ tipo: "locacao", reservationId: loc }, { parcelas: 1, primeiroVencimento: "2026-09-20" });
    await gerarRecebiveis({ tipo: "frete", freightId: frete }, { parcelas: 1, primeiroVencimento: "2026-09-12" });

    const lista = await listarEntries({ direction: "receber" });
    assert.equal(lista.filter((e) => e.origin === "locacao").reduce((a, e) => a + e.amount_cents, 0), 100000);
    assert.equal(lista.filter((e) => e.origin === "frete").reduce((a, e) => a + e.amount_cents, 0), 20000);
  });
});

describe("protecoes", () => {
  beforeEach(cenario);

  it("recusa refazer o parcelamento com recebimento ja lancado", async () => {
    const id = await locacao(120000);
    await gerarRecebiveis({ tipo: "locacao", reservationId: id }, { parcelas: 4, primeiroVencimento: "2026-09-15" });
    const parcelas = await recebiveisDe({ tipo: "locacao", reservationId: id });
    await receber(parcelas[0].id, 30000);

    const erro = await gerarRecebiveis(
      { tipo: "locacao", reservationId: id },
      { parcelas: 2, primeiroVencimento: "2026-10-15" },
    );
    assert.match(erro ?? "", /recebimento/i);
    assert.equal((await recebiveisDe({ tipo: "locacao", reservationId: id })).length, 4, "as parcelas continuam");
  });

  it("refazer sem recebimento substitui as parcelas", async () => {
    const id = await locacao(120000);
    await gerarRecebiveis({ tipo: "locacao", reservationId: id }, { parcelas: 4, primeiroVencimento: "2026-09-15" });
    await gerarRecebiveis({ tipo: "locacao", reservationId: id }, { parcelas: 2, primeiroVencimento: "2026-10-15" });
    const p = await recebiveisDe({ tipo: "locacao", reservationId: id });
    assert.equal(p.length, 2);
    assert.equal(p.reduce((a: number, x: any) => a + x.amount_cents, 0), 120000);
  });

  it("valor zero nao cria parcela", async () => {
    const id = await locacao(0);
    await gerarRecebiveis({ tipo: "locacao", reservationId: id }, { parcelas: 3, primeiroVencimento: "2026-09-15" });
    assert.equal((await recebiveisDe({ tipo: "locacao", reservationId: id })).length, 0);
  });
});

describe("sinal recebido antes do parcelamento", () => {
  beforeEach(cenario);

  async function sinal(reservationId: number, valorCents: number) {
    await insert(
      `INSERT INTO payments (reservation_id, amount_cents, method, paid_at) VALUES (?,?,'pix','2026-09-01')`,
      [reservationId, valorCents],
    );
  }

  it("as parcelas dividem o saldo, nao o total ja parcialmente pago", async () => {
    const id = await locacao(120000);
    await sinal(id, 20000);
    const erro = await gerarRecebiveis(
      { tipo: "locacao", reservationId: id },
      { parcelas: 2, primeiroVencimento: "2026-10-15" },
    );
    assert.equal(erro, null);

    const parcelas = await recebiveisDe({ tipo: "locacao", reservationId: id });
    assert.equal(
      parcelas.reduce((a: number, p: any) => a + p.amount_cents, 0),
      100000,
      "R$ 1.200 menos o sinal de R$ 200",
    );
  });

  it("o previsto a receber nao conta o sinal duas vezes", async () => {
    const id = await locacao(120000);
    await sinal(id, 20000);
    await gerarRecebiveis({ tipo: "locacao", reservationId: id }, { parcelas: 2, primeiroVencimento: "2026-10-15" });

    const totais = await totaisEntries("receber");
    assert.equal(totais.previsto, 100000);
    assert.equal(totais.saldo, 100000, "ainda faltam R$ 1.000, nao R$ 1.200");

    const emCaixa = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments`);
    assert.equal(emCaixa, 20000, "o sinal continua sendo o unico dinheiro em caixa");
  });

  it("reserva ja quitada por fora nao gera parcela", async () => {
    const id = await locacao(50000);
    await sinal(id, 50000);
    const erro = await gerarRecebiveis(
      { tipo: "locacao", reservationId: id },
      { parcelas: 3, primeiroVencimento: "2026-10-15" },
    );
    assert.match(erro ?? "", /já recebidos/i);
    assert.equal((await recebiveisDe({ tipo: "locacao", reservationId: id })).length, 0);
  });
});

describe("atraso", () => {
  beforeEach(cenario);

  it("parcela vencida e nao recebida entra no total atrasado", async () => {
    const id = await locacao(60000);
    await gerarRecebiveis({ tipo: "locacao", reservationId: id }, { parcelas: 2, primeiroVencimento: "2020-01-10" });
    const totais = await totaisEntries("receber");
    assert.equal(totais.atrasado, 60000, "as duas venceram ha muito tempo");
  });

  it("o que foi recebido sai do atraso", async () => {
    const id = await locacao(60000);
    await gerarRecebiveis({ tipo: "locacao", reservationId: id }, { parcelas: 2, primeiroVencimento: "2020-01-10" });
    const parcelas = await recebiveisDe({ tipo: "locacao", reservationId: id });
    await receber(parcelas[0].id, 30000, "2020-01-10");
    const totais = await totaisEntries("receber");
    assert.equal(totais.atrasado, 30000);
  });
});
