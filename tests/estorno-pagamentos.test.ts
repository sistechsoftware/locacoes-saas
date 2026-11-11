/**
 * Exclusão e estorno de pagamentos/adiantamentos com o SQL real da aplicação.
 *
 * Cobre a falha original (excluir lançamento com recibo emitido quebrava o
 * DELETE por causa do CHECK de receipts), separa as duas operações, prova as
 * travas contra duplicidade e confere o reflexo nos totais da reserva e nas
 * contas a receber.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { insert, one, run, scalar } from "../src/lib/db.ts";
import { excluirPagamento, estornarPagamento } from "../src/lib/estornos.ts";
import { reservationMoney } from "../src/lib/reservations.ts";
import {
  adiantamentoAberto,
  adiantamentosPendentes,
  confirmarAdiantamento,
  criarAdiantamento,
  gerarRecebiveis,
  listarEntries,
  totaisEntries,
} from "../src/lib/receber.ts";

const EMPRESA = 1;
let cliente = 0;
let seq = 0;

async function cenario() {
  createTestDb();
  seq = 0;
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
  cliente = await insert(`INSERT INTO customers (name, phone) VALUES ('Joao da Silva','11999990000')`);
}

async function reserva(totalCents: number, status = "confirmada", companyId = EMPRESA) {
  seq++;
  return await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, total_cents, company_id)
     VALUES (?,?,?,'2026-10-10',?,?)`,
    [`LIMA-${String(seq).padStart(3, "0")}`, cliente, status, totalCents, companyId],
  );
}

async function pagamento(reservationId: number, valorCents: number, entryId: number | null = null) {
  return await insert(
    `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, notes, entry_id, company_id)
     VALUES (?,?, 'pix', '2026-10-01', 'Recebimento', ?, ?)`,
    [reservationId, valorCents, entryId, EMPRESA],
  );
}

async function reciboDoPagamento(paymentId: number, numero: string) {
  return await insert(
    `INSERT INTO receipts (number, source_type, payment_id, amount_cents, paid_at, company_id)
     VALUES (?,'payment',?, 15000, '2026-10-01', ?)`,
    [numero, paymentId, EMPRESA],
  );
}

describe("falha original: lançamento com recibo emitido", () => {
  beforeEach(cenario);

  it("excluir um pagamento que tinha recibo funciona e remove o comprovante", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 15000);
    await reciboDoPagamento(p, "RCB-001");

    const res = await excluirPagamento({ paymentId: p, companyId: EMPRESA });

    assert.equal("ok" in res, true, "antes esta exclusão falhava com CHECK constraint failed");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM payments`), 0);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM receipts`), 0, "recibo do lançamento excluído sai junto");
    const m = await reservationMoney(r, EMPRESA);
    assert.equal(m.paid, 0);
    assert.equal(m.balance, 50000);
  });

  it("excluir uma reserva com recibos emitidos continua funcionando", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 15000);
    await reciboDoPagamento(p, "RCB-001");

    // cascade: reservations -> payments -> receipts(ON DELETE SET NULL)
    await run(`DELETE FROM reservations WHERE id = ?`, [r]);

    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM payments`), 0);
    const rc = await one<any>(`SELECT payment_id FROM receipts`);
    assert.equal(rc.payment_id, null, "o comprovante fica órfão, nunca impede a exclusão");
  });
});

describe("excluir pagamento", () => {
  beforeEach(cenario);

  it("sai do total recebido e a parcela vinculada reabre", async () => {
    const r = await reserva(50000);
    await gerarRecebiveis({ tipo: "locacao", reservationId: r }, { parcelas: 1, primeiroVencimento: "2026-10-10" });
    const [parcela] = await listarEntries({ direction: "receber" }, EMPRESA);
    const p = await pagamento(r, 50000, parcela.id);
    await run(`UPDATE financial_entries SET status = 'quitada' WHERE id = ?`, [parcela.id]);

    const res = await excluirPagamento({ paymentId: p, companyId: EMPRESA });

    assert.equal("ok" in res, true);
    const m = await reservationMoney(r, EMPRESA);
    assert.equal(m.paid, 0, "não compõe mais o recebido");
    assert.equal(m.balance, 50000);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM payments`), 0);
    const entry = await one<any>(`SELECT status FROM financial_entries WHERE id = ?`, [parcela.id]);
    assert.equal(entry.status, "aberta", "o status é recalculado pelo caixa");
    const totais = await totaisEntries("receber", EMPRESA);
    assert.equal(totais.liquidado, 0);
    assert.equal(totais.saldo, 50000);
  });

  it("não exclui um lançamento de estorno", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 15000);
    await estornarPagamento({ paymentId: p, companyId: EMPRESA, userId: 1 });
    const estorno = await one<any>(`SELECT id FROM payments WHERE refund_of_payment_id = ?`, [p]);

    const res = await excluirPagamento({ paymentId: estorno.id, companyId: EMPRESA });

    assert.equal("erro" in res, true);
    if ("erro" in res) assert.match(res.erro, /estorno/i);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM payments WHERE refund_of_payment_id = ?`, [p]), 1);
  });
});

describe("estornar pagamento", () => {
  beforeEach(cenario);

  it("150 de 500 devolvidos deixam receita líquida zero e histórico com entrada e saída", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 15000);

    const res = await estornarPagamento({ paymentId: p, companyId: EMPRESA, userId: 1 });

    assert.equal("ok" in res, true);
    const m = await reservationMoney(r, EMPRESA);
    assert.equal(m.paid, 0, "recebido líquido zero");
    assert.equal(m.refunded, 15000, "devolvido 150");
    assert.equal(m.balance, 50000, "saldo volta ao total");

    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM payments`), 2, "entrada original preservada");
    const estorno = await one<any>(`SELECT * FROM payments WHERE refund_of_payment_id = ?`, [p]);
    assert.equal(estorno.amount_cents, -15000);
    assert.equal(estorno.reservation_id, r);
    assert.match(String(estorno.notes), /Estorno/);
    assert.equal(await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments`), 0, "caixa líquido zero");
  });

  it("estorno duplicado é recusado", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 15000);
    await estornarPagamento({ paymentId: p, companyId: EMPRESA, userId: 1 });

    const segundo = await estornarPagamento({ paymentId: p, companyId: EMPRESA, userId: 1 });

    assert.equal("erro" in segundo, true);
    if ("erro" in segundo) assert.match(segundo.erro, /já foi estornado/i);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM payments WHERE refund_of_payment_id = ?`, [p]), 1);
  });

  it("o banco recusa um segundo estorno do mesmo recebimento", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 15000);
    const inserirEstorno = () =>
      run(
        `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, refund_of_payment_id, company_id)
         VALUES (?,?,'pix','2026-10-01',?,1)`,
        [r, -15000, p],
      );
    await inserirEstorno();

    // trava de concorrência real: índice único uq_payments_estorno_unico (0052)
    await assert.rejects(inserirEstorno, /UNIQUE constraint failed/i);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM payments WHERE refund_of_payment_id = ?`, [p]), 1);
  });

  it("não estorna um estorno", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 15000);
    const est = await estornarPagamento({ paymentId: p, companyId: EMPRESA, userId: 1 });
    assert.equal("ok" in est, true);
    const estorno = await one<any>(`SELECT id FROM payments WHERE refund_of_payment_id = ?`, [p]);

    const res = await estornarPagamento({ paymentId: estorno.id, companyId: EMPRESA, userId: 1 });

    assert.equal("erro" in res, true);
    if ("erro" in res) assert.match(res.erro, /estorno/i);
  });

  it("recusa excluir o recebimento depois de estornado", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 15000);
    await estornarPagamento({ paymentId: p, companyId: EMPRESA, userId: 1 });

    const res = await excluirPagamento({ paymentId: p, companyId: EMPRESA });

    assert.equal("erro" in res, true);
    if ("erro" in res) assert.match(res.erro, /já foi estornado/i);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM payments`), 2);
  });

  it("estorna só o pagamento escolhido e preserva os demais", async () => {
    const r = await reserva(50000);
    const p1 = await pagamento(r, 20000);
    await pagamento(r, 30000);

    await estornarPagamento({ paymentId: p1, companyId: EMPRESA, userId: 1 });

    const m = await reservationMoney(r, EMPRESA);
    assert.equal(m.paid, 30000, "os outros 300 continuam recebidos");
    assert.equal(m.refunded, 20000);
    assert.equal(m.balance, 20000);
  });

  it("reabre a parcela quitada dentro do mesmo batch", async () => {
    const r = await reserva(50000);
    await gerarRecebiveis({ tipo: "locacao", reservationId: r }, { parcelas: 1, primeiroVencimento: "2026-12-10" });
    const [parcela] = await listarEntries({ direction: "receber" }, EMPRESA);
    const p = await pagamento(r, 50000, parcela.id);
    await run(`UPDATE financial_entries SET status = 'quitada' WHERE id = ?`, [parcela.id]);

    await estornarPagamento({ paymentId: p, companyId: EMPRESA, userId: 1 });

    const entry = await one<any>(`SELECT status FROM financial_entries WHERE id = ?`, [parcela.id]);
    assert.equal(entry.status, "aberta");
    const lista = await listarEntries({ direction: "receber" }, EMPRESA);
    const alvo = lista.find((e) => e.id === parcela.id)!;
    assert.equal(alvo.liquidado_cents, 0);
    assert.equal(alvo.situacao, "aberta");
  });
});

describe("adiantamento", () => {
  beforeEach(cenario);

  it("adiantamento agendado confirmado e estornado volta a pendente, sem receita", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r,
      amountCents: 15000,
      imediato: false,
      dataPrevista: "2026-10-01",
      method: "pix",
      userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    await confirmarAdiantamento(entry.id, { paidAt: "2026-10-01", userId: 1 });
    const p = await scalar<number>(`SELECT id FROM payments WHERE entry_id = ?`, [entry.id]);
    assert.equal((await reservationMoney(r, EMPRESA)).paid, 15000);

    const res = await estornarPagamento({ paymentId: p, companyId: EMPRESA, userId: 1, motivo: "reserva cancelada" });

    assert.equal("ok" in res, true);
    const m = await reservationMoney(r, EMPRESA);
    assert.equal(m.paid, 0);
    assert.equal(m.refunded, 15000);
    assert.equal(m.balance, 50000);
    const reaberto = await adiantamentoAberto(r);
    assert.ok(reaberto, "o adiantamento volta a aparecer como pendente");
    assert.equal(reaberto.status, "aberta");
  });

  it("excluir o adiantamento recebido por engano reabre a entry e zera o recebido", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r,
      amountCents: 15000,
      imediato: false,
      dataPrevista: "2026-10-01",
      method: "pix",
      userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    await confirmarAdiantamento(entry.id, { paidAt: "2026-10-01", userId: 1 });
    const p = await scalar<number>(`SELECT id FROM payments WHERE entry_id = ?`, [entry.id]);

    const res = await excluirPagamento({ paymentId: p, companyId: EMPRESA });

    assert.equal("ok" in res, true);
    assert.equal((await reservationMoney(r, EMPRESA)).paid, 0);
    const back = await one<any>(`SELECT status FROM financial_entries WHERE id = ?`, [entry.id]);
    assert.equal(back.status, "aberta");
  });
});

describe("reserva cancelada", () => {
  beforeEach(cenario);

  it("não deixa saldo pendente aparecendo como dívida ativa", async () => {
    const r = await reserva(50000);
    await gerarRecebiveis({ tipo: "locacao", reservationId: r }, { parcelas: 2, primeiroVencimento: "2026-10-10" });
    await run(`UPDATE reservations SET status = 'cancelada' WHERE id = ?`, [r]);

    assert.equal((await listarEntries({ direction: "receber" }, EMPRESA)).length, 0);
    const totais = await totaisEntries("receber", EMPRESA);
    assert.equal(totais.previsto, 0);
    assert.equal(totais.saldo, 0);
    assert.equal(totais.atrasado, 0);
    // histórico preservado: nada foi apagado, só sai da cobrança
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM financial_entries WHERE reservation_id = ?`, [r]), 2);
  });

  it("adiantamento pendente de reserva cancelada sai das pendências", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r,
      amountCents: 15000,
      imediato: false,
      dataPrevista: "2026-01-01",
      method: "pix",
      userId: 1,
    });
    assert.equal((await adiantamentosPendentes("2026-10-10", EMPRESA)).length, 1);

    await run(`UPDATE reservations SET status = 'cancelada' WHERE id = ?`, [r]);

    assert.equal((await adiantamentosPendentes("2026-10-10", EMPRESA)).length, 0);
    assert.ok(await adiantamentoAberto(r), "o registro continua existindo");
  });
});

describe("isolamento entre empresas", () => {
  beforeEach(cenario);

  it("não exclui nem estorna lançamento de outra empresa", async () => {
    await insert(`INSERT INTO companies (id, name, active) VALUES (2,'Outra empresa',1)`);
    const r2 = await reserva(50000, "confirmada", 2);
    const p = await insert(
      `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, company_id)
       VALUES (?,10000,'pix','2026-10-01',2)`,
      [r2],
    );

    const del = await excluirPagamento({ paymentId: p, companyId: EMPRESA });
    const est = await estornarPagamento({ paymentId: p, companyId: EMPRESA, userId: 1 });

    assert.equal("erro" in del, true);
    assert.equal("erro" in est, true);
    if ("erro" in del) assert.match(del.erro, /não encontrado/i);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM payments WHERE id = ?`, [p]), 1);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM payments`), 1, "nenhum estorno criado");
  });
});
