/**
 * Adiantamento com o SQL real: os dois cenarios (pago agora / agendado),
 * confirmacao, edicao, cancelamento, dupla confirmacao e saldo da reserva.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { all, insert, one, run, scalar } from "../src/lib/db.ts";
import {
  adiantamentoAberto,
  adiantamentosDaReserva,
  adiantamentosPendentes,
  atualizarAdiantamentoAgendado,
  cancelarAdiantamentoAgendado,
  confirmarAdiantamento,
  criarAdiantamento,
  saldoDisponivelAdiantamento,
} from "../src/lib/receber.ts";
import { reservationMoney } from "../src/lib/reservations.ts";

let cliente = 0;
let seq = 0;

async function cenario() {
  createTestDb();
  seq = 0;
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
  cliente = await insert(`INSERT INTO customers (name, phone) VALUES ('Joao da Silva','11999990000')`);
}

async function reserva(totalCents: number) {
  seq++;
  return await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, total_cents)
     VALUES (?,?,'confirmada','2026-10-10',?)`,
    [`LIMA-${String(seq).padStart(3, "0")}`, cliente, totalCents],
  );
}

describe("cenario A: pago agora", () => {
  beforeEach(cenario);

  it("entra direto como dinheiro recebido, sem passar por previsao", async () => {
    const r = await reserva(50000);
    const erro = await criarAdiantamento({
      reservationId: r,
      amountCents: 20000,
      imediato: true,
      dataPrevista: "2026-09-07",
      method: "pix",
      userId: 1,
    });
    assert.equal(erro, null);

    const m = await reservationMoney(r);
    assert.equal(m.paid, 20000, "recebido de verdade");
    assert.equal(m.balance, 30000, "saldo ja desconta");
    assert.equal(m.scheduledAdvance, 0, "nao e promessa, e caixa");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM financial_entries WHERE reservation_id=?`, [r]), 0);
  });

  it("recusa valor acima do saldo da reserva", async () => {
    const r = await reserva(50000);
    const erro = await criarAdiantamento({
      reservationId: r, amountCents: 60000, imediato: true, dataPrevista: "2026-09-07", method: "pix", userId: 1,
    });
    assert.match(erro ?? "", /saldo disponível/);
    assert.equal((await reservationMoney(r)).paid, 0);
  });
});

describe("cenario B: agendado", () => {
  beforeEach(cenario);

  it("nao conta como recebido nem reduz o saldo pago ate confirmar", async () => {
    const r = await reserva(100000);
    const erro = await criarAdiantamento({
      reservationId: r, amountCents: 30000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    assert.equal(erro, null);

    const m = await reservationMoney(r);
    assert.equal(m.paid, 0, "nada foi recebido ainda");
    assert.equal(m.balance, 100000, "saldo pago nao muda");
    assert.equal(m.scheduledAdvance, 30000, "mas aparece como previsto");

    const aberto = await adiantamentoAberto(r);
    assert.equal(aberto.status, "aberta");
    assert.equal(aberto.category, "Adiantamento");
    assert.equal(aberto.expected_method, "pix");
  });

  it("apos confirmar, o exemplo completo do pedido bate exatamente", async () => {
    const r = await reserva(100000);
    await criarAdiantamento({
      reservationId: r, amountCents: 30000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const antes = await reservationMoney(r);
    assert.equal(antes.paid, 0);
    assert.equal(antes.scheduledAdvance, 30000);

    const entry = await adiantamentoAberto(r);
    const erro = await confirmarAdiantamento(entry.id, { paidAt: "2026-10-06", userId: 1 });
    assert.equal(erro, null);

    const depois = await reservationMoney(r);
    assert.equal(depois.paid, 30000, "adiantamento recebido");
    assert.equal(depois.balance, 70000, "saldo restante");
    assert.equal(depois.scheduledAdvance, 0, "nao esta mais agendado");
  });

  it("recusa agendar um segundo adiantamento enquanto o primeiro esta aberto", async () => {
    const r = await reserva(100000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const erro = await criarAdiantamento({
      reservationId: r, amountCents: 10000, imediato: false, dataPrevista: "2026-11-01", method: "pix", userId: 1,
    });
    assert.match(erro ?? "", /já existe um adiantamento agendado/i);
    assert.equal((await adiantamentosDaReserva(r)).length, 1);
  });

  it("recusa data invalida", async () => {
    const r = await reserva(50000);
    const erro = await criarAdiantamento({
      reservationId: r, amountCents: 10000, imediato: false, dataPrevista: "", method: "pix", userId: 1,
    });
    assert.ok(erro);
  });
});

describe("confirmacao", () => {
  beforeEach(cenario);

  it("usa a forma de pagamento efetiva quando informada, diferente da prevista", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    await confirmarAdiantamento(entry.id, { method: "dinheiro", paidAt: "2026-10-06", userId: 1 });
    const pagamento = await one<any>(`SELECT * FROM payments WHERE entry_id = ?`, [entry.id]);
    assert.equal(pagamento.method, "dinheiro");
  });

  it("duas confirmacoes simultaneas geram um pagamento so", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    const [a, b] = await Promise.all([
      confirmarAdiantamento(entry.id, { paidAt: "2026-10-06", userId: 1 }),
      confirmarAdiantamento(entry.id, { paidAt: "2026-10-06", userId: 1 }),
    ]);
    assert.equal([a, b].filter((x) => x === null).length, 1, "so uma pode ter sucesso");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM payments WHERE entry_id=?`, [entry.id]), 1);
    assert.equal((await reservationMoney(r)).paid, 20000, "nunca dobra");
  });

  it("confirmar de novo depois de ja confirmado e recusado com clareza", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    await confirmarAdiantamento(entry.id, { paidAt: "2026-10-06", userId: 1 });
    const segunda = await confirmarAdiantamento(entry.id, { paidAt: "2026-10-06", userId: 1 });
    assert.match(segunda ?? "", /já foi confirmado/i);
  });

  it("confirmar um adiantamento cancelado e recusado", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    await cancelarAdiantamentoAgendado(entry.id);
    const erro = await confirmarAdiantamento(entry.id, { paidAt: "2026-10-06", userId: 1 });
    assert.match(erro ?? "", /cancelado/i);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM payments`), 0);
  });
});

describe("edicao do agendado", () => {
  beforeEach(cenario);

  it("altera valor e data enquanto ainda esta aberto", async () => {
    const r = await reserva(100000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    const erro = await atualizarAdiantamentoAgendado(entry.id, {
      amountCents: 35000, dataPrevista: "2026-10-20", method: "cartao", userId: 1,
    });
    assert.equal(erro, null);
    const atualizado = await adiantamentoAberto(r);
    assert.equal(atualizado.amount_cents, 35000);
    assert.equal(atualizado.due_date, "2026-10-20");
    assert.equal(atualizado.expected_method, "cartao");
  });

  it("o novo valor pode usar o saldo que o proprio adiantamento antigo ocupava", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    // sobe para o total inteiro da reserva: so e possivel porque o proprio
    // valor antigo (20000) e devolvido ao saldo antes de validar o novo
    const erro = await atualizarAdiantamentoAgendado(entry.id, {
      amountCents: 50000, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    assert.equal(erro, null);
  });

  it("nao altera um adiantamento ja recebido", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    await confirmarAdiantamento(entry.id, { paidAt: "2026-10-06", userId: 1 });
    const erro = await atualizarAdiantamentoAgendado(entry.id, {
      amountCents: 1000, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    assert.match(erro ?? "", /já foi recebido/i);
    // o historico financeiro nao pode ter sido tocado
    const salvo = await one<any>(`SELECT amount_cents FROM financial_entries WHERE id=?`, [entry.id]);
    assert.equal(salvo.amount_cents, 20000);
  });
});

describe("cancelamento", () => {
  beforeEach(cenario);

  it("cancela o agendamento e libera o saldo", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    assert.equal(await cancelarAdiantamentoAgendado(entry.id), true);
    assert.equal(await adiantamentoAberto(r), undefined);
    assert.equal(await saldoDisponivelAdiantamento(r), 50000, "o valor volta a ficar livre");
  });

  it("depois de cancelado, pode agendar um novo adiantamento", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    await cancelarAdiantamentoAgendado(entry.id);
    const erro = await criarAdiantamento({
      reservationId: r, amountCents: 15000, imediato: false, dataPrevista: "2026-11-01", method: "pix", userId: 1,
    });
    assert.equal(erro, null);
    assert.equal((await adiantamentosDaReserva(r)).length, 2, "os dois ficam no historico");
  });

  it("cancelar um ja recebido nao faz nada", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const entry = await adiantamentoAberto(r);
    await confirmarAdiantamento(entry.id, { paidAt: "2026-10-06", userId: 1 });
    assert.equal(await cancelarAdiantamentoAgendado(entry.id), false);
    assert.equal((await reservationMoney(r)).paid, 20000, "continua recebido");
  });
});

describe("cancelamento de reserva com adiantamento pendente", () => {
  beforeEach(cenario);

  it("cancelar a reserva nao apaga o adiantamento nem quebra o historico", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    await run(`UPDATE reservations SET status='cancelada' WHERE id=?`, [r]);
    const entry = await adiantamentoAberto(r);
    assert.ok(entry, "o registro do adiantamento continua existindo");
    assert.equal(entry.status, "aberta", "cancelar a reserva nao cancela o adiantamento sozinho");
  });
});

describe("adiantamentos pendentes (painel e lembrete)", () => {
  beforeEach(cenario);

  it("lista o que vence hoje e o que ja venceu, nao o que ainda esta longe", async () => {
    const r1 = await reserva(50000);
    const r2 = await reserva(50000);
    const r3 = await reserva(50000);
    await criarAdiantamento({ reservationId: r1, amountCents: 10000, imediato: false, dataPrevista: "2026-09-07", method: "pix", userId: 1 });
    await criarAdiantamento({ reservationId: r2, amountCents: 15000, imediato: false, dataPrevista: "2026-09-01", method: "pix", userId: 1 });
    await criarAdiantamento({ reservationId: r3, amountCents: 20000, imediato: false, dataPrevista: "2026-12-25", method: "pix", userId: 1 });

    const pendentes = await adiantamentosPendentes("2026-09-07");
    assert.equal(pendentes.length, 2, "hoje e atrasado, nao o distante");
    assert.ok(pendentes.every((p: any) => p.customer_name === "Joao da Silva"));
  });

  it("recebido e cancelado nao aparecem na lista de pendentes", async () => {
    const r1 = await reserva(50000);
    const r2 = await reserva(50000);
    await criarAdiantamento({ reservationId: r1, amountCents: 10000, imediato: false, dataPrevista: "2026-09-01", method: "pix", userId: 1 });
    const e1 = await adiantamentoAberto(r1);
    await confirmarAdiantamento(e1.id, { paidAt: "2026-09-01", userId: 1 });

    await criarAdiantamento({ reservationId: r2, amountCents: 10000, imediato: false, dataPrevista: "2026-09-01", method: "pix", userId: 1 });
    const e2 = await adiantamentoAberto(r2);
    await cancelarAdiantamentoAgendado(e2.id);

    assert.equal((await adiantamentosPendentes("2026-09-07")).length, 0);
  });
});

describe("reservas antigas e pagamento parcial ja existente", () => {
  beforeEach(cenario);

  it("reserva antiga sem nenhum adiantamento continua funcionando normalmente", async () => {
    const r = await reserva(50000);
    const m = await reservationMoney(r);
    assert.equal(m.scheduledAdvance, 0);
    assert.equal(m.paid, 0);
    assert.equal(await saldoDisponivelAdiantamento(r), 50000);
  });

  it("reserva com pagamento parcial ja lancado (fora do fluxo de adiantamento) limita o novo adiantamento", async () => {
    const r = await reserva(50000);
    // um pagamento avulso, do jeito que a tela de Pagamentos ja fazia antes desta funcionalidade existir
    await insert(
      `INSERT INTO payments (reservation_id, amount_cents, method, paid_at) VALUES (?,15000,'pix','2026-09-01')`,
      [r],
    );
    assert.equal(await saldoDisponivelAdiantamento(r), 35000);
    const erro = await criarAdiantamento({
      reservationId: r, amountCents: 40000, imediato: true, dataPrevista: "2026-09-07", method: "pix", userId: 1,
    });
    assert.match(erro ?? "", /saldo disponível/);
  });
});

describe("relatorios e totais existentes continuam corretos", () => {
  beforeEach(cenario);

  it("o adiantamento pago agora soma normalmente em payments, como qualquer pagamento", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: true, dataPrevista: "2026-09-07", method: "pix", userId: 1,
    });
    await insert(`INSERT INTO payments (reservation_id, amount_cents, method, paid_at) VALUES (?,10000,'pix','2026-09-07')`, [r]);
    assert.equal(await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments`), 30000);
  });

  it("o adiantamento agendado nao aparece nos totais de caixa ate ser confirmado", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    assert.equal(await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments`), 0);
  });
});

describe("convivencia com o parcelamento comum", () => {
  beforeEach(cenario);

  it("gerar parcelas nao apaga um adiantamento agendado aberto", async () => {
    const r = await reserva(100000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const { gerarRecebiveis } = await import("../src/lib/receber.ts");
    const erro = await gerarRecebiveis(
      { tipo: "locacao", reservationId: r },
      { parcelas: 4, primeiroVencimento: "2026-10-06" },
    );
    assert.equal(erro, null);
    assert.ok(await adiantamentoAberto(r), "o adiantamento continua vivo");
  });

  it("as parcelas geradas descontam o que ja esta agendado de adiantamento", async () => {
    const r = await reserva(100000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const { gerarRecebiveis, recebiveisDe } = await import("../src/lib/receber.ts");
    await gerarRecebiveis({ tipo: "locacao", reservationId: r }, { parcelas: 4, primeiroVencimento: "2026-10-06" });
    const parcelas = await recebiveisDe({ tipo: "locacao", reservationId: r });
    const soma = parcelas.reduce((s: number, p: any) => s + p.amount_cents, 0);
    assert.equal(soma, 80000, "100000 - 20000 ja agendados de adiantamento");
  });

  it("o parcelamento nunca aparece na lista de parcelas comuns, so na sua propria secao", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: false, dataPrevista: "2026-10-06", method: "pix", userId: 1,
    });
    const { recebiveisDe } = await import("../src/lib/receber.ts");
    const parcelas = await recebiveisDe({ tipo: "locacao", reservationId: r });
    assert.equal(parcelas.length, 0, "o adiantamento nao e uma parcela comum");
  });

  it("recusa refazer parcelamento com adiantamento pago agora ja recebido, exatamente como antes", async () => {
    const r = await reserva(50000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: true, dataPrevista: "2026-09-07", method: "pix", userId: 1,
    });
    const { gerarRecebiveis, recebiveisDe } = await import("../src/lib/receber.ts");
    const erro = await gerarRecebiveis({ tipo: "locacao", reservationId: r }, { parcelas: 3, primeiroVencimento: "2026-09-10" });
    assert.equal(erro, null, "pagamento direto (entry_id nulo) nao bloqueia, so desconta");
    const parcelas = await recebiveisDe({ tipo: "locacao", reservationId: r });
    assert.equal(parcelas.reduce((s: number, p: any) => s + p.amount_cents, 0), 30000, "50000 - 20000 ja pago");
  });

  it("se o adiantamento confirmado cobre o total, avisa e nao gera parcela vazia", async () => {
    const r = await reserva(20000);
    await criarAdiantamento({
      reservationId: r, amountCents: 20000, imediato: true, dataPrevista: "2026-09-07", method: "pix", userId: 1,
    });
    const { gerarRecebiveis } = await import("../src/lib/receber.ts");
    const erro = await gerarRecebiveis({ tipo: "locacao", reservationId: r }, { parcelas: 1, primeiroVencimento: "2026-09-10" });
    assert.match(erro ?? "", /Nada a parcelar/);
  });
});
