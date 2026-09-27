/**
 * Recibos com o SQL real: emissao, idempotencia, concorrencia e, acima de
 * tudo, PRESERVACAO — nenhum teste aqui pode terminar com um lancamento
 * financeiro alterado, apagado ou duplicado por causa do recibo.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { all, insert, one, scalar } from "../src/lib/db.ts";
import {
  emitirRecibo,
  excluirRecibo,
  obterRecibo,
  reciboDePagamento,
  recibosDaReserva,
} from "../src/lib/recibos.ts";
import { valorPorExtenso } from "../src/lib/recibo-visual.ts";
import {
  criarAdiantamento,
  confirmarAdiantamento,
  adiantamentoAberto,
} from "../src/lib/receber.ts";

let cliente = 0;
let seq = 0;

async function cenario() {
  createTestDb();
  seq = 0;
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
  cliente = await insert(`INSERT INTO customers (name, doc, phone) VALUES ('Joao da Silva','12345678909','11999990000')`);
}

async function reserva(totalCents: number) {
  seq++;
  return await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, total_cents, address, city)
     VALUES (?,?,'confirmada','2026-10-10',?, 'Rua das Flores, 100','Sao Paulo')`,
    [`LIMA-${String(seq).padStart(3, "0")}`, cliente, totalCents],
  );
}

async function pagamento(reservationId: number, amountCents: number, opts: { notes?: string; entryId?: number } = {}) {
  return await insert(
    `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, notes, entry_id, created_by)
     VALUES (?,?,?,?,?,?,1)`,
    [reservationId, amountCents, "pix", "2026-09-15", opts.notes ?? null, opts.entryId ?? null],
  );
}

/** Fotografia completa dos livros financeiros, para provar que nada mudou. */
async function fotoFinanceira(reservationId: number) {
  return JSON.stringify({
    payments: await all(`SELECT * FROM payments WHERE reservation_id = ? ORDER BY id`, [reservationId]),
    deposits: await all(`SELECT * FROM deposits WHERE reservation_id = ? ORDER BY id`, [reservationId]),
    entries: await all(`SELECT * FROM financial_entries WHERE reservation_id = ? ORDER BY id`, [reservationId]),
  });
}

describe("emissao de recibo de pagamento", () => {
  beforeEach(cenario);

  it("gera recibo com numero proprio da serie RCB, valor e dados do lancamento", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 20000, { notes: "Entrada" });

    const { erro, receiptId } = await emitirRecibo({ tipo: "payment", paymentId: p }, { userId: 1, userName: "Op" });
    assert.equal(erro, null);

    const rec = await one<any>(`SELECT * FROM receipts WHERE id = ?`, [receiptId]);
    assert.equal(rec.number, "RCB-001");
    assert.equal(rec.source_type, "payment");
    assert.equal(rec.payment_id, p);
    assert.equal(rec.amount_cents, 20000);
    assert.equal(rec.paid_at, "2026-09-15");
    assert.equal(rec.method, "pix");
    assert.equal(rec.issued_by, 1);
    assert.match(rec.body, /Joao da Silva/);
    assert.match(rec.body, /R\$ 200,00/);
  });

  it("a serie RCB nao interfere na numeracao de nenhum outro documento", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 20000);
    await emitirRecibo({ tipo: "payment", paymentId: p });

    // parcelamento continua na serie REC dele, sem pular numero nem colidir
    const { gerarRecebiveis } = await import("../src/lib/receber.ts");
    const erro = await gerarRecebiveis({ tipo: "locacao", reservationId: r }, { parcelas: 2, primeiroVencimento: "2026-10-10" });
    assert.equal(erro, null);
    const numeros = (await all(`SELECT number FROM financial_entries WHERE reservation_id = ?`, [r])).map((e: any) => e.number);
    assert.deepEqual(numeros, ["REC-001", "REC-002"]);
  });

  it("numera em sequencia: dois recibos, RCB-001 e RCB-002", async () => {
    const r = await reserva(50000);
    const p1 = await pagamento(r, 10000);
    const p2 = await pagamento(r, 10000);
    const a = await emitirRecibo({ tipo: "payment", paymentId: p1 });
    const b = await emitirRecibo({ tipo: "payment", paymentId: p2 });
    assert.equal(a.erro, null);
    assert.equal(b.erro, null);
    const n1 = await one<any>(`SELECT number FROM receipts WHERE id = ?`, [a.receiptId]);
    const n2 = await one<any>(`SELECT number FROM receipts WHERE id = ?`, [b.receiptId]);
    assert.equal(n1.number, "RCB-001");
    assert.equal(n2.number, "RCB-002");
  });

  it("recusa pagamento inexistente com mensagem clara", async () => {
    const { erro } = await emitirRecibo({ tipo: "payment", paymentId: 999999 });
    assert.match(erro ?? "", /não encontrado/i);
  });

  it("recusa estorno (pagamento negativo): recibo comprova dinheiro que entrou", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, -10000);
    const { erro } = await emitirRecibo({ tipo: "payment", paymentId: p });
    assert.match(erro ?? "", /estorno/i);
    assert.equal(await scalar(`SELECT COUNT(*) FROM receipts`), 0);
  });
});

describe("idempotencia e concorrencia", () => {
  beforeEach(cenario);

  it("emitir duas vezes o mesmo pagamento devolve o MESMO recibo, sem duplicar", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 20000);
    const primeira = await emitirRecibo({ tipo: "payment", paymentId: p });
    const segunda = await emitirRecibo({ tipo: "payment", paymentId: p });
    assert.equal(primeira.erro, null);
    assert.equal(segunda.erro, null);
    assert.equal(primeira.receiptId, segunda.receiptId);
    assert.equal(await scalar(`SELECT COUNT(*) FROM receipts WHERE payment_id = ?`, [p]), 1);
  });

  it("duas emissoes simultaneas do mesmo pagamento geram um recibo so", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 20000);
    const [a, b] = await Promise.all([
      emitirRecibo({ tipo: "payment", paymentId: p }),
      emitirRecibo({ tipo: "payment", paymentId: p }),
    ]);
    assert.equal(a.erro, null);
    assert.equal(b.erro, null);
    assert.equal(a.receiptId, b.receiptId, "as duas corridas convergem para o mesmo recibo");
    assert.equal(await scalar(`SELECT COUNT(*) FROM receipts WHERE payment_id = ?`, [p]), 1);
  });

  it("excluir e reemitir funciona: o mesmo lancamento pode ter comprovante novo", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 20000);
    const primeiro = await emitirRecibo({ tipo: "payment", paymentId: p });
    await excluirRecibo(primeiro.receiptId!);
    assert.equal(await scalar(`SELECT COUNT(*) FROM receipts`), 0);
    const reemitido = await emitirRecibo({ tipo: "payment", paymentId: p });
    assert.equal(reemitido.erro, null);
    const rec = await one<any>(`SELECT number FROM receipts WHERE id = ?`, [reemitido.receiptId]);
    // o numero volta a ficar livre porque o recibo anterior foi excluido de
    // proposito: nunca existem dois recibos vivos com o mesmo numero
    assert.equal(rec.number, "RCB-001");
  });
});

describe("preservacao dos lancamentos", () => {
  beforeEach(cenario);

  it("emitir recibo nao altera NENHUMA linha financeira da reserva", async () => {
    const r = await reserva(50000);
    const p1 = await pagamento(r, 20000, { notes: "Entrada" });
    const antes = await fotoFinanceira(r);

    const { erro } = await emitirRecibo({ tipo: "payment", paymentId: p1 }, { userId: 1, userName: "Op" });
    assert.equal(erro, null);

    const depois = await fotoFinanceira(r);
    assert.equal(depois, antes, "payments, deposits e financial_entries permanecem byte a byte iguais");
  });

  it("erro na emissao nao compromete o lancamento: ele segue intacto e a emissao pode ser tentada de novo", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 20000);
    const antes = await fotoFinanceira(r);

    const tentativaRuim = await emitirRecibo({ tipo: "payment", paymentId: 999999 });
    assert.ok(tentativaRuim.erro, "falha com mensagem");
    const depois = await fotoFinanceira(r);
    assert.equal(depois, antes, "nenhum dado foi tocado no erro");

    // e a emissao correta funciona depois, no mesmo lancamento
    const boa = await emitirRecibo({ tipo: "payment", paymentId: p });
    assert.equal(boa.erro, null);
  });

  it("excluir o recibo nao toca no pagamento", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 20000);
    const { receiptId } = await emitirRecibo({ tipo: "payment", paymentId: p });
    await excluirRecibo(receiptId!);
    const pagamentoAtual = await one<any>(`SELECT * FROM payments WHERE id = ?`, [p]);
    assert.equal(pagamentoAtual.amount_cents, 20000);
    assert.equal(pagamentoAtual.paid_at, "2026-09-15");
  });
});

describe("recibo de adiantamento", () => {
  beforeEach(cenario);

  it("adiantamento pago agora (payment direto) ganha recibo que o identifica", async () => {
    const r = await reserva(50000);
    const erroAdiantamento = await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: true, dataPrevista: "2026-09-15", method: "pix", userId: 1,
    });
    assert.equal(erroAdiantamento, null);
    const pag = await one<any>(`SELECT * FROM payments WHERE reservation_id = ?`, [r]);
    assert.equal(pag.notes, "Adiantamento");

    const { erro, receiptId } = await emitirRecibo({ tipo: "payment", paymentId: pag.id });
    assert.equal(erro, null);
    const rec = await one<any>(`SELECT * FROM receipts WHERE id = ?`, [receiptId]);
    assert.match(rec.body, /Adiantamento/);
    // money() usa espaco nao separavel (U+00A0) entre "R$" e o valor
    assert.match(rec.body, /R\$\u00a0200,00/);
  });

  it("adiantamento agendado e confirmado vira pagamento com entry e ganha recibo", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-01", method: "pix", userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    const erroConfirmacao = await confirmarAdiantamento(entry.id, { paidAt: "2026-10-01", userId: 1 });
    assert.equal(erroConfirmacao, null);
    const pag = await one<any>(`SELECT * FROM payments WHERE entry_id = ?`, [entry.id]);
    assert.ok(pag, "o pagamento do adiantamento confirmado existe");

    const { erro, receiptId } = await emitirRecibo({ tipo: "payment", paymentId: pag.id });
    assert.equal(erro, null);
    const rec = await one<any>(`SELECT * FROM receipts WHERE id = ?`, [receiptId]);
    assert.equal(rec.entry_id, entry.id);
    assert.match(rec.body, /Adiantamento/);

    // e o adiantamento em si permanece o que sempre foi
    const entryDepois = await one<any>(`SELECT * FROM financial_entries WHERE id = ?`, [entry.id]);
    assert.equal(entryDepois.amount_cents, 20000);
    assert.equal(entryDepois.status, "quitada");
  });
});

describe("recibo de caucao", () => {
  beforeEach(cenario);

  async function cauxaoRecebida(reservationId: number) {
    return await insert(
      `INSERT INTO deposits (reservation_id, amount_cents, method, received_at, status)
       VALUES (?,?, 'pix','2026-09-15','recebida')`,
      [reservationId, 30000],
    );
  }

  it("caucao recebida gera recibo identificado como caucao", async () => {
    const r = await reserva(50000);
    const d = await cauxaoRecebida(r);
    const { erro, receiptId } = await emitirRecibo({ tipo: "deposit", depositId: d });
    assert.equal(erro, null);
    const rec = await one<any>(`SELECT * FROM receipts WHERE id = ?`, [receiptId]);
    assert.equal(rec.source_type, "deposit");
    assert.equal(rec.deposit_id, d);
    assert.equal(rec.amount_cents, 30000);
    assert.match(rec.body, /CAUÇÃO/);
  });

  it("caucao nao recebida e recusada: nao ha valor a comprovar", async () => {
    const r = await reserva(50000);
    const d = await insert(
      `INSERT INTO deposits (reservation_id, amount_cents, status) VALUES (?,?,'nao_recebida')`,
      [r, 30000],
    );
    const { erro } = await emitirRecibo({ tipo: "deposit", depositId: d });
    assert.match(erro ?? "", /não foi recebida/i);
    assert.equal(await scalar(`SELECT COUNT(*) FROM receipts`), 0);
  });

  it("emitir recibo de caucao nao altera o deposito", async () => {
    const r = await reserva(50000);
    const d = await cauxaoRecebida(r);
    const antes = await fotoFinanceira(r);
    await emitirRecibo({ tipo: "deposit", depositId: d });
    const depois = await fotoFinanceira(r);
    assert.equal(depois, antes);
  });
});

describe("consulta de recibos", () => {
  beforeEach(cenario);

  it("recibosDaReserva traz pagamento e caucao da mesma reserva", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 20000);
    const d = await insert(
      `INSERT INTO deposits (reservation_id, amount_cents, method, received_at, status) VALUES (?,30000,'pix','2026-09-15','recebida')`,
      [r],
    );
    await emitirRecibo({ tipo: "payment", paymentId: p });
    await emitirRecibo({ tipo: "deposit", depositId: d });
    const recibos = await recibosDaReserva(r);
    assert.equal(recibos.length, 2);
    assert.ok(recibos.every((rc: any) => rc.number.startsWith("RCB-")));
  });

  it("reciboDePagamento encontra o recibo pelo lancamento", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 20000);
    const { receiptId } = await emitirRecibo({ tipo: "payment", paymentId: p });
    const rec = await reciboDePagamento(p);
    assert.equal(rec.id, receiptId);
  });

  it("obterRecibo devolve dados reais do lancamento para a pagina", async () => {
    const r = await reserva(50000);
    const p = await pagamento(r, 20000, { notes: "Entrada" });
    const { receiptId } = await emitirRecibo({ tipo: "payment", paymentId: p });
    const dados: any = await obterRecibo(receiptId!);
    assert.equal(dados.lancamentoExiste, true);
    assert.equal(dados.tipo, "Pagamento");
    assert.equal(dados.cliente.name, "Joao da Silva");
    assert.equal(dados.reserva.reservation_number, "LIMA-001");
    assert.equal(dados.valorAtual, 20000);
    assert.equal(dados.descricao, "Entrada");
  });

  it("obterRecibo de caucao traz o cliente e a reserva", async () => {
    const r = await reserva(50000);
    const d = await insert(
      `INSERT INTO deposits (reservation_id, amount_cents, method, received_at, status) VALUES (?,30000,'pix','2026-09-15','recebida')`,
      [r],
    );
    const { receiptId } = await emitirRecibo({ tipo: "deposit", depositId: d });
    const dados: any = await obterRecibo(receiptId!);
    assert.equal(dados.tipo, "Caução");
    assert.equal(dados.cliente.name, "Joao da Silva");
  });
});

describe("valor por extenso", () => {
  it("forma corretamente os valores comuns de recibo", () => {
    assert.equal(valorPorExtenso(20000), "duzentos reais");
    assert.equal(valorPorExtenso(125080), "mil duzentos e cinquenta reais e oitenta centavos");
    assert.equal(valorPorExtenso(100), "um real");
    assert.equal(valorPorExtenso(1), "um centavo");
    assert.equal(valorPorExtenso(150), "um real e cinquenta centavos");
    assert.equal(valorPorExtenso(100000), "mil reais");
    assert.equal(valorPorExtenso(0), "zero reais");
    assert.equal(valorPorExtenso(2000000), "vinte mil reais");
    assert.equal(valorPorExtenso(110000), "mil e cem reais");
    assert.equal(valorPorExtenso(2100), "vinte e um reais");
  });
});
