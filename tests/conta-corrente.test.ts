/**
 * Conta Corrente com SQL real: vinculo historico (migration 0018), idempotencia
 * (rodar duas vezes nao muda nada), preservacao de valores/datas/status e o
 * fluxo dos novos lancamentos (pagamento, adiantamento nos dois cenarios,
 * parcelamento e baixa de parcela) gravando a conta de origem.
 *
 * Escopo do vinculo historico: os dois livros do REALIZADO (payments e
 * expenses). Previsoes em aberto e caucoes nao sao dinheiro e ficam de fora.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "./helpers/d1.ts";
import { all, insert, one, run, scalar } from "../src/lib/db.ts";
import { criarAdiantamento, confirmarAdiantamento, gerarRecebiveis } from "../src/lib/receber.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRACAO = fs.readFileSync(path.join(ROOT, "migrations", "0018_conta_corrente.sql"), "utf8");

let cliente = 0;
let seq = 0;
let usuario = 0;

async function cenario() {
  createTestDb();
  seq = 0;
  usuario = await insert(`INSERT INTO users (name, username, password_hash, role) VALUES ('Op','op','x','admin')`);
  cliente = await insert(`INSERT INTO customers (name, phone) VALUES ('Joao da Silva','11999990000')`);
}

async function reserva(totalCents: number, status = "confirmada") {
  seq++;
  return await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, total_cents)
     VALUES (?,?,?,?,?)`,
    [`LIMA-${String(seq).padStart(3, "0")}`, cliente, status, "2026-10-10", totalCents],
  );
}

async function aplicarMigracao() {
  // mesmo caminho do wrangler: executa o arquivo SQL puro no SQLite
  const db = (globalThis as any).__limasTestDb;
  db.sqlite.exec(MIGRACAO);
}

async function contaAtiva(): Promise<number> {
  const c = await one<any>(`SELECT id FROM financial_accounts WHERE active = 1 LIMIT 1`);
  return c?.id ?? 0;
}

/* ------------------------------------------------------------------ */
/* Migration 0018                                                      */
/* ------------------------------------------------------------------ */

describe("migration 0018: vinculo historico", () => {
  beforeEach(cenario);

  it("cria a Conta Corrente quando nenhuma conta ativa existe", async () => {
    await aplicarMigracao();
    const conta = await one<any>(`SELECT * FROM financial_accounts WHERE active = 1`);
    assert.ok(conta, "deveria ter criado a conta");
    assert.equal(conta.name, "Conta Corrente");
  });

  it("nao cria conta nem mexe no cadastro quando ja existe uma ativa", async () => {
    // createTestDb ja aplicou a 0018 (que criou a conta padrao); limpa para
    // simular o cadastro que ja tinha a propria conta antes da migration
    await run(`DELETE FROM financial_accounts`);
    const minha = await insert(
      `INSERT INTO financial_accounts (name, kind, initial_balance_cents) VALUES ('Caixa da Lima','dinheiro',12345)`,
    );
    await aplicarMigracao();
    const contas = await all<any>(`SELECT id, name FROM financial_accounts`);
    assert.equal(contas.length, 1);
    assert.equal(contas[0].id, minha);
    assert.equal(contas[0].name, "Caixa da Lima");
    assert.equal(await contaAtiva(), minha);
  });

  it("vincula pagamentos com reserva sem alterar valor, data, metodo ou status", async () => {
    const r = await reserva(50000);
    const p1 = await insert(
      `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, notes) VALUES (?,?,?,?,?)`,
      [r, 20000, "pix", "2026-08-01", "Sinal"],
    );
    await aplicarMigracao();
    const conta = await contaAtiva();
    const p = await one<any>(`SELECT * FROM payments WHERE id = ?`, [p1]);
    assert.equal(p.account_id, conta);
    assert.equal(p.amount_cents, 20000, "valor intocado");
    assert.equal(p.paid_at, "2026-08-01", "data intocada");
    assert.equal(p.method, "pix", "metodo intocado");
    assert.equal(p.notes, "Sinal", "observacao intocada");
    assert.equal(p.entry_id ?? null, null, "origem intocada");
  });

  it("vincula todo o realizado (mesmo avulso) e nao toca em previsao em aberto", async () => {
    const p = await insert(
      `INSERT INTO payments (amount_cents, method, paid_at, notes) VALUES (?,?,?,?)`,
      [10000, "dinheiro", "2026-08-01", "Entrada avulsa"],
    );
    const avulsa = await insert(
      `INSERT INTO expenses (date, category, description, amount_cents) VALUES (?,?,?,?)`,
      ["2026-08-02", "Outros", "Gasto avulso", 3000],
    );
    // previsao em aberto NAO e dinheiro: nao pode receber conta pela migration
    const previsao = await insert(
      `INSERT INTO financial_entries (number, direction, origin, category, description, amount_cents, due_date)
       VALUES ('REC-998','receber','locacao','Locacao','Reserva 1/2',25000,'2026-08-10')`,
    );
    await aplicarMigracao();

    const conta = await contaAtiva();
    assert.equal((await one<any>(`SELECT account_id FROM payments WHERE id = ?`, [p])).account_id, conta);
    assert.equal((await one<any>(`SELECT account_id FROM expenses WHERE id = ?`, [avulsa])).account_id, conta);
    assert.equal(
      (await one<any>(`SELECT account_id FROM financial_entries WHERE id = ?`, [previsao])).account_id ?? null,
      null,
      "previsto nao e caixa",
    );
  });

  it("e idempotente: rodar duas vezes nao muda nenhum dado", async () => {
    const r = await reserva(50000);
    await insert(`INSERT INTO payments (reservation_id, amount_cents, method, paid_at) VALUES (?,?,?,?)`, [
      r,
      20000,
      "pix",
      "2026-08-01",
    ]);
    await insert(`INSERT INTO expenses (date, category, amount_cents, reservation_id) VALUES (?,?,?,?)`, [
      "2026-08-02",
      "Combustivel",
      5000,
      r,
    ]);

    await aplicarMigracao();
    const depois1 = await all<any>(
      `SELECT 'p' AS livro, id, amount_cents, account_id, paid_at, method FROM payments
       UNION ALL SELECT 'e', id, amount_cents, account_id, date, method FROM expenses ORDER BY livro, id`,
    );
    const total1 = await scalar<number>(`SELECT SUM(amount_cents) FROM payments`);
    const saidas1 = await scalar<number>(`SELECT SUM(amount_cents) FROM expenses`);

    await aplicarMigracao();
    const depois2 = await all<any>(
      `SELECT 'p' AS livro, id, amount_cents, account_id, paid_at, method FROM payments
       UNION ALL SELECT 'e', id, amount_cents, account_id, date, method FROM expenses ORDER BY livro, id`,
    );
    const total2 = await scalar<number>(`SELECT SUM(amount_cents) FROM payments`);
    const saidas2 = await scalar<number>(`SELECT SUM(amount_cents) FROM expenses`);

    assert.deepEqual(depois2, depois1, "segunda execucao nao pode alterar linha nenhuma");
    assert.equal(total2, total1);
    assert.equal(saidas2, saidas1);
    assert.equal((await all<any>(`SELECT id FROM financial_accounts`)).length, 1, "nao pode duplicar a conta");
  });

  it("mantem os totais do caixa identicos antes e depois do vinculo", async () => {
    const r = await reserva(70000);
    await insert(`INSERT INTO payments (reservation_id, amount_cents, method, paid_at) VALUES (?,?,?,?)`, [
      r,
      30000,
      "pix",
      "2026-08-01",
    ]);
    await insert(`INSERT INTO expenses (date, category, amount_cents, reservation_id) VALUES (?,?,?,?)`, [
      "2026-08-02",
      "Combustivel",
      9000,
      r,
    ]);

    const entradasAntes = await scalar<number>(`SELECT SUM(amount_cents) FROM payments`);
    const saidasAntes = await scalar<number>(`SELECT SUM(amount_cents) FROM expenses`);
    const qtdAntes = await scalar<number>(`SELECT COUNT(*) FROM payments`);

    await aplicarMigracao();

    const entradasDepois = await scalar<number>(`SELECT SUM(amount_cents) FROM payments`);
    const saidasDepois = await scalar<number>(`SELECT SUM(amount_cents) FROM expenses`);
    const qtdDepois = await scalar<number>(`SELECT COUNT(*) FROM payments`);

    assert.equal(entradasDepois, entradasAntes);
    assert.equal(saidasDepois, saidasAntes);
    assert.equal(qtdDepois, qtdAntes);
  });
});

/* ------------------------------------------------------------------ */
/* Novos lancamentos com conta                                         */
/* ------------------------------------------------------------------ */

describe("novos lancamentos gravam a Conta Corrente", () => {
  beforeEach(cenario);

  it("adiantamento pago agora grava account_id no payments", async () => {
    const conta = await contaAtiva(); // createTestDb ja garante a Conta Corrente da 0018
    const r = await reserva(50000);
    const erro = await criarAdiantamento({
      reservationId: r,
      amountCents: 20000,
      imediato: true,
      dataPrevista: "2026-09-01",
      method: "pix",
      accountId: conta,
      userId: usuario,
    });
    assert.equal(erro, null);
    const p = await one<any>(`SELECT * FROM payments WHERE reservation_id = ?`, [r]);
    assert.equal(p.account_id, conta, "o dinheiro tem que saber em qual conta caiu");
  });

  it("adiantamento agendado guarda a conta na previsao e leva para o payment na confirmacao", async () => {
    const conta = await contaAtiva();
    const r = await reserva(50000);

    const erro = await criarAdiantamento({
      reservationId: r,
      amountCents: 15000,
      imediato: false,
      dataPrevista: "2026-10-01",
      method: "pix",
      accountId: conta,
      userId: usuario,
    });
    assert.equal(erro, null);

    const entry = await one<any>(`SELECT * FROM financial_entries WHERE reservation_id = ? AND category = 'Adiantamento'`, [r]);
    assert.equal(entry.account_id, conta, "a previsao nasce sabendo a conta");

    const erroConfirm = await confirmarAdiantamento(entry.id, { paidAt: "2026-10-01", userId: usuario });
    assert.equal(erroConfirm, null);
    const p = await one<any>(`SELECT * FROM payments WHERE entry_id = ?`, [entry.id]);
    assert.ok(p);
    assert.equal(p.account_id, conta, "a confirmacao herda a conta da previsao");

    // saldo da conta: 15000 entrou uma unica vez
    const saldo = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE account_id = ?`, [conta]);
    assert.equal(saldo, 15000);
  });

  it("pagamento direto da tela da reserva com conta selecionada", async () => {
    const conta = await contaAtiva();
    const r = await reserva(50000);
    await insert(
      `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, notes, account_id, created_by)
       VALUES (?,?,?,?,?,?,?)`,
      [r, 25000, "cartao", "2026-09-05", "Entrada", conta, usuario],
    );
    const p = await one<any>(`SELECT * FROM payments WHERE reservation_id = ?`, [r]);
    assert.equal(p.account_id, conta);
    const saldo = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE account_id = ?`, [conta]);
    assert.equal(saldo, 25000);
  });

  it("parcelamento gravado com conta e baixa de parcela herdam a conta", async () => {
    const conta = await contaAtiva();
    const r = await reserva(40000);

    const erro = await gerarRecebiveis(
      { tipo: "locacao", reservationId: r },
      { parcelas: 2, primeiroVencimento: "2026-10-10", accountId: conta, userId: usuario },
    );
    assert.equal(erro, null);

    const parcelas = await all<any>(
      `SELECT * FROM financial_entries WHERE reservation_id = ? AND direction = 'receber' ORDER BY installment`,
      [r],
    );
    assert.equal(parcelas.length, 2);
    for (const p of parcelas) assert.equal(p.account_id, conta, "cada parcela nasce com a conta");

    // baixa da primeira parcela: o recebimento herda a conta quando o form nao manda outra
    await insert(
      `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, notes, entry_id, account_id, created_by)
       VALUES (?,?,?,?,?,?,?,?)`,
      [r, parcelas[0].amount_cents, "pix", "2026-10-10", parcelas[0].description, parcelas[0].id, parcelas[0].account_id, usuario],
    );
    const recebido = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE entry_id = ?`, [
      parcelas[0].id,
    ]);
    assert.equal(recebido, parcelas[0].amount_cents);
    const saldoConta = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE account_id = ?`, [
      conta,
    ]);
    assert.equal(saldoConta, parcelas[0].amount_cents);
  });

  it("saldo da conta = inicial + entradas - saidas, somente com movimentos da propria conta", async () => {
    // usa a Conta Corrente padrao da 0018 e uma segunda conta para provar o isolamento
    const conta = await contaAtiva();
    const outra = await insert(`INSERT INTO financial_accounts (name, kind) VALUES ('Outra','dinheiro')`);

    const r = await reserva(100000);
    await insert(`INSERT INTO payments (reservation_id, amount_cents, method, paid_at, account_id) VALUES (?,?,?,?,?)`, [
      r,
      30000,
      "pix",
      "2026-09-01",
      conta,
    ]);
    await insert(`INSERT INTO payments (reservation_id, amount_cents, method, paid_at, account_id) VALUES (?,?,?,?,?)`, [
      r,
      7000,
      "pix",
      "2026-09-02",
      outra,
    ]);
    await insert(`INSERT INTO expenses (date, category, amount_cents, reservation_id, account_id) VALUES (?,?,?,?,?)`, [
      "2026-09-03",
      "Combustivel",
      5000,
      r,
      conta,
    ]);

    const entradas = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE account_id = ?`, [conta]);
    const saidas = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE account_id = ?`, [conta]);
    assert.equal(10000 + entradas - saidas, 35000, "saldo formula: inicial + entradas - saidas");
  });
});
