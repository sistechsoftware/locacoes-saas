/**
 * Lancamento manual de contas a pagar, de ponta a ponta com o SQL real:
 * criacao avulsa e parcelada, datas distintas de compra e vencimento, baixa
 * pelo fluxo existente, atomicidade e ausencia de efeitos colaterais.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { all, insert, run, scalar } from "../src/lib/db.ts";
import { criarContaPagarManual, cancelarContaPagarManual, validarPagar, validarData } from "../src/lib/pagar.ts";
import { listarEntries, totaisEntries } from "../src/lib/receber.ts";

/**
 * Reproduz a baixa existente (payEntry) ao nivel do banco, sem depender do
 * Next: grava a saida em expenses ligada a parcela pelo entry_id e quita a
 * parcela quando o pago cobre o valor. E exatamente o caminho que uma conta
 * manual percorre hoje, sem nenhuma logica nova de pagamento.
 */
async function baixaParcela(entryId: number, valorDigitado: string, data = "2026-10-05", method = "pix") {
  const valor = Math.round(Number(valorDigitado.replace(/\./g, "").replace(",", ".")) * 100);
  const entry = (await all<any>(`SELECT * FROM financial_entries WHERE id = ?`, [entryId]))[0];
  await insert(
    `INSERT INTO expenses (date, category, description, amount_cents, method, status, entry_id, supplier_id, purchase_id, kind, created_by)
     VALUES (?,?,?,?,?,'pago',?,?,?,?,?)`,
    [data, entry.category || "Compras", entry.description, valor, method, entryId, entry.supplier_id, entry.purchase_id, entry.category === "Investimentos" ? "investimento" : "operacional", 1],
  );
  const pago = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE entry_id = ?`, [entryId]);
  if (pago >= entry.amount_cents) {
    await run(`UPDATE financial_entries SET status = 'quitada' WHERE id = ?`, [entryId]);
  }
}

let fornecedor = 0;
let seq = 0;

async function cenario() {
  createTestDb();
  seq = 0;
  // o lancamento guarda created_by, que referencia users(id)
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
  fornecedor = await insert(`INSERT INTO suppliers (name) VALUES ('Fornecedor Teste')`);
}

type EntradaPagar = Parameters<typeof criarContaPagarManual>[0];

function criar(fdOverrides: Partial<EntradaPagar> = {}) {
  return criarContaPagarManual({
    descricao: "Compra de produto no cartão",
    amountCents: 50000,
    purchaseDate: "2026-09-10",
    dueDate: "2026-10-05",
    parcelas: 1,
    categoria: "Compras",
    supplierId: null,
    accountId: null,
    notes: null,
    userId: 1,
    ...fdOverrides,
  });
}

describe("Teste 1 - criar conta manual avulsa", () => {
  beforeEach(cenario);

  it("grava compra 10/09, vencimento 05/10 e status pendente", async () => {
    const { id, erro } = await criar();
    assert.equal(erro, null);

    const e = (await all<any>(`SELECT * FROM financial_entries WHERE id = ?`, [id]))[0];
    assert.equal(e.direction, "pagar");
    assert.equal(e.origin, "despesa", "origem manual usa o valor 'despesa' que ja existe no CHECK");
    assert.equal(e.purchase_date, "2026-09-10", "a data da compra NAO e substituida pela do vencimento");
    assert.equal(e.due_date, "2026-10-05", "o vencimento NAO e substituido pela data da compra");
    assert.equal(e.amount_cents, 50000);
    assert.equal(e.status, "aberta", "nasce pendente/em aberto");
    assert.equal(e.installment, 1);
    assert.equal(e.installments_total, 1);
    assert.match(e.number, /^PAG-/);
  });

  it("aparece na listagem de A pagar com as duas datas", async () => {
    const { id } = await criar();
    const lista = await listarEntries({ direction: "pagar" });
    const item = lista.find((x) => x.id === id)!;
    assert.ok(item, "conta manual aparece na tela de Contas a Pagar");
    assert.equal(item.purchase_date, "2026-09-10");
    assert.equal(item.due_date, "2026-10-05");
    assert.equal(item.situacao, "aberta");
  });

  it("nao gera saida de caixa, compra, estoque nem movimentacao", async () => {
    await criar();
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM expenses`), 0, "nenhuma saida criada");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM purchases`), 0, "nenhuma compra criada");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM stock_movements`), 0, "estoque intocado");
    assert.equal(await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM expenses`), 0);
  });

  it("o previsto entra no painel de A pagar, o realizado nao", async () => {
    await criar();
    const totais = await totaisEntries("pagar");
    assert.equal(totais.previsto, 50000, "previsto conta a conta manual");
    assert.equal(totais.liquidado, 0, "nada pago ainda");
    assert.equal(totais.saldo, 50000, "saldo a pagar inclui a conta manual");
  });
});

describe("Teste 2 - categoria e fornecedor", () => {
  beforeEach(cenario);

  it("mantem a finalidade e o fornecedor escolhidos", async () => {
    const { id } = await criar({ categoria: "Combustivel", supplierId: fornecedor });
    const e = (await all<any>(`SELECT category, supplier_id FROM financial_entries WHERE id = ?`, [id]))[0];
    assert.equal(e.category, "Combustivel");
    assert.equal(e.supplier_id, fornecedor);

    const lista = await listarEntries({ direction: "pagar" });
    const item = lista.find((x) => x.id === id)!;
    assert.equal(item.supplier_name, "Fornecedor Teste", "fornecedor aparece na listagem");
  });

  it("sem categoria usa o padrao coerente com as parcelas de compra", async () => {
    const { id } = await criar({ categoria: "" });
    const e = (await all<any>(`SELECT category FROM financial_entries WHERE id = ?`, [id]))[0];
    assert.equal(e.category, "Compras");
  });
});

describe("Teste 3 - baixa pelo fluxo existente (payEntry)", () => {
  beforeEach(cenario);

  it("pagar a parcela cria saida em expenses e quita a conta", async () => {
    const { id } = await criar();
    await baixaParcela(id!, "500,00", "2026-10-05", "cartao");

    const pago = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE entry_id = ?`, [id]);
    assert.equal(pago, 50000, "a baixa existente registrou a saida");

    const e = (await all<any>(`SELECT status FROM financial_entries WHERE id = ?`, [id]))[0];
    assert.equal(e.status, "quitada", "a conta ficou quitada pela baixa comum");

    const totais = await totaisEntries("pagar");
    assert.equal(totais.liquidado, 50000);
    assert.equal(totais.saldo, 0);
  });

  it("pagamento parcial deixa a conta parcial, nao quitada", async () => {
    const { id } = await criar();
    await baixaParcela(id!, "200,00");

    const lista = await listarEntries({ direction: "pagar" });
    const item = lista.find((x) => x.id === id)!;
    assert.equal(item.situacao, "parcial");
    assert.equal(item.liquidado_cents, 20000);
    assert.equal(item.saldo_cents, 30000);
  });

  it("a conta manual vencida entra no total atrasado", async () => {
    await criar({ purchaseDate: "2020-01-01", dueDate: "2020-01-10" });
    const totais = await totaisEntries("pagar");
    assert.equal(totais.atrasado, 50000, "vencida e nao paga entra no atrasado");
  });
});

describe("Teste 4 - parcelamento manual", () => {
  beforeEach(cenario);

  it("R$ 1.200 em 3x divide e avanca os vencimentos mes a mes", async () => {
    const { erro } = await criar({ amountCents: 120000, parcelas: 3, dueDate: "2026-10-05", descricao: "Compra parcelada" });
    assert.equal(erro, null);

    const parcelas = await all<any>(
      `SELECT * FROM financial_entries WHERE origin = 'despesa' ORDER BY installment`,
    );
    assert.equal(parcelas.length, 3);
    assert.deepEqual(
      parcelas.map((p) => [p.installment, p.amount_cents, p.due_date]),
      [
        [1, 40000, "2026-10-05"],
        [2, 40000, "2026-11-05"],
        [3, 40000, "2026-12-05"],
      ],
      "mesma regra de parcelamento das compras: vencimentos mensais",
    );
    assert.equal(parcelas.reduce((a, p) => a + p.amount_cents, 0), 120000, "a soma bate com o total");
    assert.ok(parcelas.every((p) => p.purchase_date === "2026-09-10"), "todas guardam a mesma competencia");
    assert.ok(parcelas.every((p) => p.installments_total === 3));
    assert.ok(parcelas.every((p) => /^PAG-/.test(p.number)));
  });

  it("sobra de centavos vai para a primeira parcela, como nas compras", async () => {
    await criar({ amountCents: 10000, parcelas: 3, dueDate: "2026-10-05" }); // R$ 100 em 3x
    const parcelas = await all<any>(`SELECT amount_cents FROM financial_entries WHERE origin = 'despesa' ORDER BY installment`);
    assert.deepEqual(
      parcelas.map((p) => p.amount_cents),
      [3334, 3333, 3333],
      "R$ 33,34 + 33,33 + 33,33 = R$ 100,00",
    );
  });

  it("pagar a primeira parcela quita so ela", async () => {
    await criar({ amountCents: 120000, parcelas: 3, dueDate: "2026-10-05" });
    const parcelas = await all<any>(`SELECT * FROM financial_entries WHERE origin = 'despesa' ORDER BY installment`);
    await baixaParcela(parcelas[0].id, "400,00");

    const status = await all<any>(`SELECT installment, status FROM financial_entries WHERE origin = 'despesa' ORDER BY installment`);
    assert.deepEqual(
      status.map((s) => s.status),
      ["quitada", "aberta", "aberta"],
      "so a primeira parcela foi quitada",
    );
  });
});

describe("Teste 5 e 6 - compatibilidade com o que ja existia", () => {
  beforeEach(cenario);

  it("parcelas de compra continuam origin='compra' e sem purchase_date proprio", async () => {
    const produto = await insert(`INSERT INTO products (code, name, kind, total_qty) VALUES ('MESA','Mesa','simples',10)`);
    const compra = await insert(
      `INSERT INTO purchases (number, supplier_id, purchase_date, total_cents, affects_stock) VALUES ('COMP-001',?, '2026-09-01', 0, 0)`,
      [fornecedor],
    );
    await insert(`INSERT INTO purchase_items (purchase_id, product_id, qty, unit_price_cents) VALUES (?,?,1,10000)`, [compra, produto]);
    await insert(
      `INSERT INTO financial_entries (number, direction, origin, purchase_id, category, description, amount_cents, due_date, installment, installments_total)
       VALUES ('PAG-001','pagar','compra',?,'Compras','Compra COMP-001',10000,'2026-10-01',1,1)`,
      [compra],
    );

    const e = (await all<any>(`SELECT * FROM financial_entries WHERE number = 'PAG-001'`))[0];
    assert.equal(e.origin, "compra", "origem de compra preservada");
    assert.equal(e.purchase_date, null, "parcela de compra continua lendo a data pela tabela purchases");

    const lista = await listarEntries({ direction: "pagar" });
    const item = lista.find((x) => x.id === e.id)!;
    assert.equal(item.purchase_number, "COMP-001", "vinculo com a compra continua resolvido na listagem");
  });

  it("cancelamento manual recusa parcela de compra", async () => {
    const compra = await insert(
      `INSERT INTO purchases (number, purchase_date, total_cents) VALUES ('COMP-001','2026-09-01',10000)`,
    );
    const entry = await insert(
      `INSERT INTO financial_entries (number, direction, origin, purchase_id, category, description, amount_cents, due_date)
       VALUES ('PAG-001','pagar','compra',?,'Compras','Compra COMP-001',10000,'2026-10-01')`,
      [compra],
    );
    const erro = await cancelarContaPagarManual(entry);
    assert.match(erro ?? "", /manualmente/i);
    const e = (await all<any>(`SELECT status FROM financial_entries WHERE id = ?`, [entry]))[0];
    assert.equal(e.status, "aberta", "nada mudou");
  });
});

describe("Teste 10 - validacoes e atomicidade", () => {
  beforeEach(cenario);

  it("recusa descricao vazia", () => {
    assert.match(validarPagar({ descricao: "  ", amountCents: 50000, purchaseDate: "2026-09-10", dueDate: "2026-10-05", parcelas: 1, userId: 1 }) ?? "", /descri/i);
  });

  it("recusa valor zero, negativo e nao inteiro", () => {
    const base = { descricao: "x", purchaseDate: "2026-09-10", dueDate: "2026-10-05", parcelas: 1, userId: 1 };
    assert.match(validarPagar({ ...base, amountCents: 0 }) ?? "", /valor/i);
    assert.match(validarPagar({ ...base, amountCents: -100 }) ?? "", /valor/i);
    assert.match(validarPagar({ ...base, amountCents: 100.5 }) ?? "", /valor/i);
  });

  it("recusa datas invalidas, inclusive dia impossivel", () => {
    assert.match(validarData("2026-13-01", "data") ?? "", /data/i);
    assert.match(validarData("2026-02-31", "data") ?? "", /data/i, "30 de fevereiro nao existe");
    assert.equal(validarData("2026-02-28", "data"), null);
    assert.equal(validarData("2024-02-29", "data"), null, "bissexto e valido");
  });

  it("vencimento anterior a compra e permitido (registro tardio)", async () => {
    const { erro } = await criar({ purchaseDate: "2026-10-01", dueDate: "2026-09-01" });
    assert.equal(erro, null, "a competencia pode ser posterior ao vencimento");
  });

  it("entrada invalida nao grava nada", async () => {
    const { erro } = await criar({ descricao: "", amountCents: 50000 });
    assert.match(erro ?? "", /descri/i);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM financial_entries`), 0, "nenhum registro parcial");
  });

  it("erro no meio do batch nao deixa registros incompletos", async () => {
    // fornecedor inexistente viola a chave estrangeira no meio do batch de 3 parcelas
    const { erro } = await criar({ amountCents: 120000, parcelas: 3, dueDate: "2026-10-05", supplierId: 99999 });
    assert.ok(erro, "o batch falhou e o erro subiu");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM financial_entries`), 0, "ou entram as 3, ou nenhuma");
  });

  it("cancelar conta sem pagamento marca como cancelada e preserva o registro", async () => {
    const { id } = await criar();
    const erro = await cancelarContaPagarManual(id!);
    assert.equal(erro, null);
    const e = (await all<any>(`SELECT status FROM financial_entries WHERE id = ?`, [id]))[0];
    assert.equal(e.status, "cancelada", "o registro continua no historico");
  });

  it("cancelar conta com pagamento recusa e preserva", async () => {
    const { id } = await criar();
    await insert(
      `INSERT INTO expenses (date, category, description, amount_cents, method, status, entry_id) VALUES ('2026-10-05','Compras','pago',50000,'pix','pago',?)`,
      [id],
    );
    const erro = await cancelarContaPagarManual(id!);
    assert.match(erro ?? "", /estorne/i);
    const e = (await all<any>(`SELECT status FROM financial_entries WHERE id = ?`, [id]))[0];
    assert.equal(e.status, "aberta");
  });
});
