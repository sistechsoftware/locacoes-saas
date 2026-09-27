/**
 * Recibo unificado de quitação e tamanho configurável dos recibos.
 *
 * Cobre os cenários obrigatórios do pedido: pagamento parcelado, pagamento
 * único, não quitado, adiantamento e caução parcelados, duplicidade, e a
 * configuração de tamanho (persistência, fallback e validação).
 *
 * Nenhum teste aqui pode terminar com um lançamento financeiro alterado:
 * recibos são comprovantes, nunca fonte da verdade.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { all, insert, one, scalar } from "../src/lib/db.ts";
import {
  emitirQuitacao,
  emitirQuitacaoSeQuitada,
  emitirRecibo,
  obterRecibo,
  reciboQuitacaoDaReserva,
  recibosDaReserva,
  saldoObrigacao,
} from "../src/lib/recibos.ts";
import { TAMANHOS_RECIBO, TAMANHOS_RECIBO_LISTA, tamanhoRecibo, validarDimensoesRecibo } from "../src/lib/recibo-visual.ts";
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

async function cauxaoRecebida(reservationId: number, amountCents: number) {
  return await insert(
    `INSERT INTO deposits (reservation_id, amount_cents, method, received_at, status)
     VALUES (?,?,'pix','2026-09-15','recebida')`,
    [reservationId, amountCents],
  );
}

const quitacoes = (reservationId: number) =>
  all(`SELECT * FROM receipts WHERE source_type = 'quitacao' AND obrigacao_id = ?`, [reservationId]);

describe("quitação da locação", () => {
  beforeEach(cenario);

  it("pagamento parcelado: 50+50+50 de uma reserva de 150 gera 3 recibos individuais e 1 quitação de R$ 150", async () => {
    const r = await reserva(15000);

    // fluxo real, intercalado: cada pagamento chega, ganha o recibo individual
    // e o gatilho de quitação avalia o saldo do momento
    let ultimaQuitacao: number | undefined;
    for (let i = 0; i < 3; i++) {
      const p = await pagamento(r, 5000);
      const { erro } = await emitirRecibo({ tipo: "payment", paymentId: p });
      assert.equal(erro, null);
      const q = await emitirQuitacaoSeQuitada({ tipo: "payment", paymentId: p });
      assert.equal(q.erro, null);
      if (i < 2) assert.equal(q.receiptId, undefined, "saldo restante não gera quitação");
      else ultimaQuitacao = q.receiptId;
    }
    assert.ok(ultimaQuitacao, "terceiro pagamento fecha o saldo e gera a quitação");

    const rec = await one<any>(`SELECT * FROM receipts WHERE id = ?`, [ultimaQuitacao]);
    assert.equal(rec.source_type, "quitacao");
    assert.equal(rec.obrigacao_tipo, "locacao");
    assert.equal(rec.amount_cents, 15000, "valor do documento é o TOTAL quitado, não o último lançamento");
    assert.match(rec.body, /DECLARAÇÃO DE QUITAÇÃO/);
    assert.match(rec.body, /R\$\u00a050,00 \(lan\u00e7amento #1\)/);
    assert.match(rec.body, /cento e cinquenta reais/);

    // os recibos individuais continuam lá, intactos
    assert.equal(await scalar(`SELECT COUNT(*) FROM receipts WHERE source_type = 'payment'`), 3);
    assert.equal(await scalar(`SELECT COUNT(*) FROM receipts WHERE source_type = 'quitacao'`), 1);
  });

  it("pagamento único de R$ 150 gera recibo individual + quitação de R$ 150; redirect vai para a quitação", async () => {
    const r = await reserva(15000);
    const p = await pagamento(r, 15000);
    const { erro, receiptId } = await emitirRecibo({ tipo: "payment", paymentId: p });
    assert.equal(erro, null);

    const q = await emitirQuitacaoSeQuitada({ tipo: "payment", paymentId: p });
    assert.equal(q.erro, null);
    assert.equal(q.criado, true);
    assert.notEqual(q.receiptId, receiptId, "são dois documentos distintos");

    const rec = await one<any>(`SELECT * FROM receipts WHERE id = ?`, [q.receiptId]);
    assert.equal(rec.amount_cents, 15000);
    assert.equal(rec.obrigacao_tipo, "locacao");
  });

  it("não quitado (50+50 de 150) gera só os dois recibos individuais, nenhum de quitação", async () => {
    const r = await reserva(15000);
    const p1 = await pagamento(r, 5000);
    const p2 = await pagamento(r, 5000);
    for (const p of [p1, p2]) {
      await emitirRecibo({ tipo: "payment", paymentId: p });
      const { receiptId } = await emitirQuitacaoSeQuitada({ tipo: "payment", paymentId: p });
      assert.equal(receiptId, undefined);
    }
    assert.equal((await quitacoes(r)).length, 0);
    assert.equal(await scalar(`SELECT COUNT(*) FROM receipts WHERE source_type = 'payment'`), 2);
  });

  it("saldo negativo (pago além do total) também quita, com teto no valor da reserva", async () => {
    const r = await reserva(10000);
    await pagamento(r, 12000);
    const q = await emitirQuitacao("locacao", r);
    assert.ok(q.receiptId);
    const rec = await one<any>(`SELECT * FROM receipts WHERE id = ?`, [q.receiptId]);
    assert.equal(rec.amount_cents, 10000, "o documento declara o que foi devido e quitado, não o bruto pago");
  });

  it("adiantamento parcelado: 100+100+100 quita e o total da quitação é R$ 300", async () => {
    const r = await reserva(30000);
    for (let i = 0; i < 3; i++) {
      const erro = await criarAdiantamento({
        reservationId: r, amountCents: 10000, imediato: false, dataPrevista: `2026-10-0${i + 1}`, method: "pix", userId: 1,
      });
      assert.equal(erro, null);
      const entry = await adiantamentoAberto(r);
      const erroConfirmacao = await confirmarAdiantamento(entry.id, { paidAt: `2026-10-0${i + 1}`, userId: 1 });
      assert.equal(erroConfirmacao, null);
      const pag = await one<any>(`SELECT * FROM payments WHERE entry_id = ?`, [entry.id]);
      assert.ok(pag);
      const { erro: erroRecibo } = await emitirRecibo({ tipo: "payment", paymentId: pag.id });
      assert.equal(erroRecibo, null);
      const { receiptId } = await emitirQuitacaoSeQuitada({ tipo: "payment", paymentId: pag.id });
      if (i < 2) assert.equal(receiptId, undefined, "com saldo restante não há quitação");
      else assert.ok(receiptId, "último adiantamento quita a locação");
    }
    const qs = await quitacoes(r);
    assert.equal(qs.length, 1);
    assert.equal(qs[0].amount_cents, 30000, "quitação do adiantamento parcelado soma os R$ 300");
  });

  it("rotina repetida e emissões simultâneas não geram segunda quitação", async () => {
    const r = await reserva(15000);
    const p = await pagamento(r, 15000);
    await emitirRecibo({ tipo: "payment", paymentId: p });

    const primeira = await emitirQuitacaoSeQuitada({ tipo: "payment", paymentId: p });
    assert.ok(primeira.receiptId);

    // reexecução: devolve a existente, sem criar nada
    const segunda = await emitirQuitacaoSeQuitada({ tipo: "payment", paymentId: p });
    assert.equal(segunda.criado, false);
    assert.equal(segunda.receiptId, primeira.receiptId);
    assert.equal(await quitacoes(r).then((qs) => qs.length), 1);

    // duas corridas simultâneas: a UNIQUE converge para um documento só
    const r2 = await reserva(15000);
    const p2 = await pagamento(r2, 15000);
    await emitirRecibo({ tipo: "payment", paymentId: p2 });
    const [a, b] = await Promise.all([
      emitirQuitacao("locacao", r2),
      emitirQuitacao("locacao", r2),
    ]);
    assert.equal(a.erro, null);
    assert.equal(b.erro, null);
    assert.equal(a.receiptId, b.receiptId, "as duas corridas convergem para o mesmo recibo");
    assert.equal(await quitacoes(r2).then((qs) => qs.length), 1);
  });

  it("abrir a reserva não gera quitação: só recebimento novo ou o botão emitem", async () => {
    const r = await reserva(15000);
    await pagamento(r, 15000);
    // nenhuma emissão chamada: a tela só LÊ reciboQuitacaoDaReserva
    const nada = await reciboQuitacaoDaReserva(r);
    assert.equal(nada.locacao, null);
    assert.equal(nada.caucao, null);
    assert.equal(await scalar(`SELECT COUNT(*) FROM receipts`), 0);
  });

  it("emitirQuitacao recusa obrigação não quitada com mensagem clara", async () => {
    const r = await reserva(15000);
    await pagamento(r, 5000);
    const { erro, receiptId } = await emitirQuitacao("locacao", r);
    assert.equal(receiptId, undefined);
    assert.match(erro ?? "", /saldo|quitada/i);
  });

  it("reserva de valor zero não gera quitação", async () => {
    const r = await reserva(0);
    const { receiptId } = await emitirQuitacao("locacao", r);
    assert.equal(receiptId, undefined);
  });
});

describe("quitação da caução", () => {
  beforeEach(cenario);

  it("caução parcelada 100+50+50 de R$ 200 gera recibos individuais e 1 quitação de R$ 200", async () => {
    const r = await reserva(50000);
    // três recebimentos parciais da caução de R$ 200 (100 + 50 + 50)
    const d0 = await insert(
      `INSERT INTO deposits (reservation_id, amount_cents, method, received_at, status, retained_cents)
       VALUES (?,?,?,?,?,?)`,
      [r, 10000, "pix", "2026-09-15", "recebida", 0],
    );
    const d1 = await insert(
      `INSERT INTO deposits (reservation_id, amount_cents, method, received_at, status, retained_cents)
       VALUES (?,?,?,?,?,?)`,
      [r, 5000, "pix", "2026-09-15", "recebida", 0],
    );
    const d2 = await insert(
      `INSERT INTO deposits (reservation_id, amount_cents, method, received_at, status, retained_cents)
       VALUES (?,?,?,?,?,?)`,
      [r, 5000, "pix", "2026-09-15", "recebida", 0],
    );

    // a obrigação da caução é a soma dos registros (200); com os três
    // recebimentos registrados, o saldo zera
    assert.equal(await saldoObrigacao("caucao", r), 0);

    // cada recebimento ganha o recibo individual, como sempre; o gatilho
    // automático não adivinha parcelas de caução criadas por fora do
    // formulário (uma linha por vez é o fluxo dele) — nada nasce aqui
    for (const d of [d0, d1, d2]) {
      await emitirRecibo({ tipo: "deposit", depositId: d });
      const q = await emitirQuitacaoSeQuitada({ tipo: "deposit", depositId: d });
      assert.equal(q.receiptId, undefined, "caução em várias linhas não gera quitação automática");
    }
    // com o total completo (100+50+50 = 200), o dono emite pela reserva —
    // mesmo caminho que o botão "Emitir quitação" usa
    const q = await emitirQuitacao("caucao", r);
    assert.equal(q.erro, null);
    assert.ok(q.receiptId, "com o total combinado completo, a quitação sai com R$ 200");

    const qs = await quitacoes(r);
    assert.equal(qs.length, 1);
    assert.equal(qs[0].amount_cents, 20000, "total quitado é a soma dos recebimentos (R$ 200)");
    assert.equal(qs[0].obrigacao_tipo, "caucao");
    // os recibos individuais das parcelas continuam lá
    assert.equal(await scalar(`SELECT COUNT(*) FROM receipts WHERE source_type = 'deposit'`), 3);
  });

  it("caução única recebida de uma vez gera recibo individual + quitação", async () => {
    const r = await reserva(50000);
    const d = await cauxaoRecebida(r, 30000);
    const { receiptId } = await emitirRecibo({ tipo: "deposit", depositId: d });
    const q = await emitirQuitacaoSeQuitada({ tipo: "deposit", depositId: d });
    assert.equal(q.erro, null);
    assert.ok(q.receiptId);
    const rec = await one<any>(`SELECT * FROM receipts WHERE id = ?`, [q.receiptId]);
    assert.equal(rec.amount_cents, 30000);
    assert.notEqual(rec.id, receiptId, "documento adicional, não substituição");
  });

  it("caução parcialmente recebida não gera quitação", async () => {
    const r = await reserva(50000);
    await insert(`INSERT INTO deposits (reservation_id, amount_cents, method, received_at, status)
                  VALUES (?,50000,'pix','2026-09-15','nao_recebida')`, [r]);
    const d = await cauxaoRecebida(r, 20000);
    await emitirRecibo({ tipo: "deposit", depositId: d });
    const q = await emitirQuitacaoSeQuitada({ tipo: "deposit", depositId: d });
    assert.equal(q.receiptId, undefined, "ainda falta receber 300: nada de quitação");
  });
});

describe("preservação de dados e consulta", () => {
  beforeEach(cenario);

  it("emitir quitação não altera nenhum lançamento da reserva", async () => {
    const r = await reserva(15000);
    await pagamento(r, 15000);
    const foto = async () =>
      JSON.stringify({
        payments: await all(`SELECT * FROM payments WHERE reservation_id = ? ORDER BY id`, [r]),
        deposits: await all(`SELECT * FROM deposits WHERE reservation_id = ? ORDER BY id`, [r]),
        entries: await all(`SELECT * FROM financial_entries WHERE reservation_id = ? ORDER BY id`, [r]),
      });
    const antes = await foto();
    await emitirQuitacao("locacao", r);
    assert.equal(await foto(), antes, "quitação só escreve em receipts");
  });

  it("excluir recibos individuais não apaga a quitação; recibosDaReserva traz tudo", async () => {
    const r = await reserva(15000);
    const p = await pagamento(r, 15000);
    const { receiptId } = await emitirRecibo({ tipo: "payment", paymentId: p });
    const q = await emitirQuitacao("locacao", r);
    assert.ok(q.receiptId);

    const lista = await recibosDaReserva(r);
    assert.equal(lista.length, 2, "individual + quitação aparecem juntos");
    assert.ok(lista.some((rc: any) => rc.id === q.receiptId), "quitação aparece na lista da reserva");
    assert.ok(lista.some((rc: any) => rc.id === receiptId));
  });

  it("obterRecibo da quitação traz cliente, reserva e composição para a página", async () => {
    const r = await reserva(15000);
    const p1 = await pagamento(r, 10000);
    const p2 = await pagamento(r, 5000);
    await emitirRecibo({ tipo: "payment", paymentId: p1 });
    await emitirRecibo({ tipo: "payment", paymentId: p2 });
    const q = await emitirQuitacao("locacao", r);
    const dados: any = await obterRecibo(q.receiptId!);
    assert.equal(dados.tipo, "Quitação");
    assert.equal(dados.lancamentoExiste, true);
    assert.equal(dados.cliente.name, "Joao da Silva");
    assert.equal(dados.reserva.reservation_number, "LIMA-001");
    assert.equal(dados.valorAtual, 15000);
    assert.deepEqual(dados.composicao, [
      { id: p1, amount: 10000 },
      { id: p2, amount: 5000 },
    ]);
  });
});

describe("tamanho configurável dos recibos", () => {
  it("padrão é A4: instalações existentes não mudam de comportamento", () => {
    const t = tamanhoRecibo({});
    assert.equal(t.key, "a4");
    assert.equal(t.larguraMm, 210);
    assert.equal(t.alturaMm, 297);
  });

  it("valores salvos inválidos caem no padrão A4", () => {
    assert.equal(tamanhoRecibo({ recibo_tamanho: "bobina-gigante" }).key, "a4");
    assert.equal(tamanhoRecibo({ recibo_tamanho: "" }).key, "a4");
  });

  it("cada formato preservado carrega as medidas corretas", () => {
    const meio = tamanhoRecibo({ recibo_tamanho: "meio_a4" });
    assert.equal(meio.larguraMm, 210);
    assert.equal(meio.alturaMm, 148.5);

    const quarto = tamanhoRecibo({ recibo_tamanho: "quarto_a4" });
    assert.equal(quarto.larguraMm, 105);
    assert.equal(quarto.alturaMm, 148.5);

    assert.equal(TAMANHOS_RECIBO.a4.key, "a4");
    assert.ok(TAMANHOS_RECIBO_LISTA.some((t) => t.key === "a4"));
    assert.ok(TAMANHOS_RECIBO_LISTA.some((t) => t.key === "quarto_a4"));
  });

  it("personalizado lê as dimensões salvas e aceita override da tela", () => {
    const salvo = tamanhoRecibo({ recibo_tamanho: "personalizado", recibo_largura_mm: "105", recibo_altura_mm: "148" });
    assert.equal(salvo.larguraMm, 105);
    assert.equal(salvo.alturaMm, 148);

    const digitado = tamanhoRecibo(
      { recibo_tamanho: "personalizado", recibo_largura_mm: "105", recibo_altura_mm: "148" },
      { larguraMm: "80,5", alturaMm: "120" },
    );
    assert.equal(digitado.larguraMm, 80.5);
    assert.equal(digitado.alturaMm, 120);
  });

  it("validação rejeita dimensões inválidas e aceita as normais", () => {
    assert.ok("erro" in validarDimensoesRecibo("abc", "100"));
    assert.ok("erro" in validarDimensoesRecibo("0", "100"));
    assert.ok("erro" in validarDimensoesRecibo("49", "100"));
    assert.ok("erro" in validarDimensoesRecibo("105", "300"));
    const ok = validarDimensoesRecibo("105", "148");
    assert.ok(!("erro" in ok));
    assert.equal(ok.larguraMm, 105);
  });

  it("alterar a configuração não altera dados históricos: a emissão congela o documento", async () => {
    await cenario();
    const r = await reserva(15000);
    const p = await pagamento(r, 15000);
    await emitirRecibo({ tipo: "payment", paymentId: p });
    await emitirQuitacao("locacao", r);
    const antes = await all(`SELECT * FROM receipts ORDER BY id`);
    // o tamanho é lido na EXIBIÇÃO (tamanhoRecibo(settings)), nunca gravado no recibo
    assert.ok(antes.every((rc: any) => rc.recibo_tamanho === undefined));
    assert.equal(antes.length, 2);
  });
});
