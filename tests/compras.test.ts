/**
 * Compras de ponta a ponta, com o SQL real sobre SQLite em memoria:
 * compra historica x compra atual, parcelamento, edicao e cancelamento.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { all, insert, one, run, scalar } from "../src/lib/db.ts";
import {
  purchaseEntries,
  purchaseItems,
  recalcPurchase,
  syncPurchaseEntries,
  syncPurchaseStock,
} from "../src/lib/compras.ts";

let mesa = 0;
let cadeira = 0;
let fornecedor = 0;
let seq = 0;

async function cenario() {
  createTestDb();
  seq = 0;
  mesa = await insert(`INSERT INTO products (code,name,kind,total_qty) VALUES ('MESA','Mesa','simples',20)`);
  cadeira = await insert(`INSERT INTO products (code,name,kind,total_qty) VALUES ('CAD','Cadeira','simples',80)`);
  fornecedor = await insert(`INSERT INTO suppliers (name) VALUES ('Fornecedor Teste')`);
}

async function criarCompra(
  itens: { product_id: number; qty: number; unit_price_cents: number }[],
  opts: { afetaEstoque: boolean; desconto?: number } = { afetaEstoque: true },
) {
  seq += 1;
  const id = await insert(
    `INSERT INTO purchases (number, supplier_id, purchase_date, discount_cents, affects_stock)
     VALUES (?,?,?,?,?)`,
    [`COMP-${String(seq).padStart(3, "0")}`, fornecedor, "2026-09-10", opts.desconto ?? 0, opts.afetaEstoque ? 1 : 0],
  );
  for (const i of itens) {
    await insert(
      `INSERT INTO purchase_items (purchase_id, product_id, qty, unit_price_cents) VALUES (?,?,?,?)`,
      [id, i.product_id, i.qty, i.unit_price_cents],
    );
  }
  await recalcPurchase(id);
  await syncPurchaseStock(id);
  return id;
}

const estoque = async (id: number) => await scalar<number>(`SELECT total_qty FROM products WHERE id = ?`, [id]);

describe("Teste 3 - compra historica", () => {
  beforeEach(cenario);

  it("registra o gasto sem mexer no estoque atual", async () => {
    const id = await criarCompra(
      [
        { product_id: mesa, qty: 10, unit_price_cents: 10000 },
        { product_id: cadeira, qty: 40, unit_price_cents: 4000 },
      ],
      { afetaEstoque: false },
    );

    assert.equal(await estoque(mesa), 20, "estoque de mesas nao muda");
    assert.equal(await estoque(cadeira), 80, "estoque de cadeiras nao muda");

    const compra = await one<any>(`SELECT total_cents FROM purchases WHERE id = ?`, [id]);
    assert.equal(compra.total_cents, 260000, "o financeiro registra R$ 2.600");

    const movs = await all<any>(`SELECT * FROM stock_movements WHERE purchase_id = ?`, [id]);
    assert.equal(movs.length, 0, "nao gera movimentacao de estoque");
  });
});

describe("Teste 4 - compra atual", () => {
  beforeEach(cenario);

  it("registra o gasto e soma ao estoque", async () => {
    const id = await criarCompra([
      { product_id: mesa, qty: 5, unit_price_cents: 10000 },
      { product_id: cadeira, qty: 20, unit_price_cents: 4000 },
    ]);

    assert.equal(await estoque(mesa), 25, "20 + 5");
    assert.equal(await estoque(cadeira), 100, "80 + 20");

    const compra = await one<any>(`SELECT total_cents FROM purchases WHERE id = ?`, [id]);
    assert.equal(compra.total_cents, 130000);

    const movs = await all<any>(`SELECT product_id, qty_delta, reason FROM stock_movements WHERE purchase_id = ?`, [id]);
    assert.equal(movs.length, 2);
    assert.ok(movs.every((m) => m.reason === "compra"));
  });

  it("Teste 11 - varios produtos entram todos", async () => {
    const forro = await insert(`INSERT INTO products (code,name,kind,total_qty) VALUES ('FRM','Forro','simples',5)`);
    await criarCompra([
      { product_id: mesa, qty: 5, unit_price_cents: 10000 },
      { product_id: cadeira, qty: 20, unit_price_cents: 4000 },
      { product_id: forro, qty: 5, unit_price_cents: 3000 },
    ]);
    assert.equal(await estoque(mesa), 25);
    assert.equal(await estoque(cadeira), 100);
    assert.equal(await estoque(forro), 10);
  });
});

describe("Teste 14 - nao duplicar estoque", () => {
  beforeEach(cenario);

  it("salvar a mesma compra varias vezes nao soma de novo", async () => {
    const id = await criarCompra([{ product_id: mesa, qty: 5, unit_price_cents: 10000 }]);
    assert.equal(await estoque(mesa), 25);

    await syncPurchaseStock(id);
    await syncPurchaseStock(id);
    await syncPurchaseStock(id);
    assert.equal(await estoque(mesa), 25, "continua 25 depois de tres gravacoes");

    const movs = await all<any>(`SELECT * FROM stock_movements WHERE purchase_id = ?`, [id]);
    assert.equal(movs.length, 1, "so a movimentacao original");
  });
});

describe("Teste 12 - editar a quantidade", () => {
  beforeEach(cenario);

  it("aumentar de 5 para 7 movimenta apenas 2", async () => {
    const id = await criarCompra([{ product_id: mesa, qty: 5, unit_price_cents: 10000 }]);
    assert.equal(await estoque(mesa), 25);

    await run(`UPDATE purchase_items SET qty = 7 WHERE purchase_id = ?`, [id]);
    await syncPurchaseStock(id);
    assert.equal(await estoque(mesa), 27);
  });

  it("reduzir de 5 para 3 devolve 2", async () => {
    const id = await criarCompra([{ product_id: mesa, qty: 5, unit_price_cents: 10000 }]);
    await run(`UPDATE purchase_items SET qty = 3 WHERE purchase_id = ?`, [id]);
    await syncPurchaseStock(id);
    assert.equal(await estoque(mesa), 23, "20 + 3");
  });
});

describe("Teste 13 - cancelar compra", () => {
  beforeEach(cenario);

  it("estorna o estoque e mantem o historico", async () => {
    const id = await criarCompra([{ product_id: mesa, qty: 5, unit_price_cents: 10000 }]);
    assert.equal(await estoque(mesa), 25);

    await run(`UPDATE purchases SET status = 'cancelada' WHERE id = ?`, [id]);
    await syncPurchaseStock(id);

    assert.equal(await estoque(mesa), 20, "voltou ao original");
    const movs = await all<any>(`SELECT qty_delta, reason FROM stock_movements WHERE purchase_id = ? ORDER BY id`, [id]);
    assert.deepEqual(
      movs.map((m) => [m.qty_delta, m.reason]),
      [
        [5, "compra"],
        [-5, "estorno_compra"],
      ],
      "as duas movimentacoes ficam registradas",
    );
  });

  it("compra cancelada nao volta a movimentar ao ser regravada", async () => {
    const id = await criarCompra([{ product_id: mesa, qty: 5, unit_price_cents: 10000 }]);
    await run(`UPDATE purchases SET status = 'cancelada' WHERE id = ?`, [id]);
    await syncPurchaseStock(id);
    await syncPurchaseStock(id);
    assert.equal(await estoque(mesa), 20);
  });
});

describe("Teste 5 e 6 - compra parcelada", () => {
  beforeEach(cenario);

  it("cria as parcelas somando o total da compra", async () => {
    const id = await criarCompra([{ product_id: mesa, qty: 50, unit_price_cents: 10000 }]);
    const erro = await syncPurchaseEntries(id, { parcelas: 10, primeiroVencimento: "2026-10-05" });
    assert.equal(erro, null);

    const parcelas = await purchaseEntries(id);
    assert.equal(parcelas.length, 10);
    assert.equal(
      parcelas.reduce((a: number, p: any) => a + p.amount_cents, 0),
      500000,
      "a soma das parcelas bate com a compra",
    );
    assert.ok(parcelas.every((p: any) => p.direction === "pagar" && p.origin === "compra"));
  });

  it("o estoque entra inteiro mesmo com pagamento parcelado", async () => {
    const id = await criarCompra([{ product_id: cadeira, qty: 10, unit_price_cents: 4000 }]);
    await syncPurchaseEntries(id, { parcelas: 10, primeiroVencimento: "2026-10-05" });
    assert.equal(await estoque(cadeira), 90, "as 10 cadeiras entram na hora");
  });

  it("so a parcela paga vira saida de caixa", async () => {
    const id = await criarCompra([{ product_id: mesa, qty: 50, unit_price_cents: 10000 }]);
    await syncPurchaseEntries(id, { parcelas: 10, primeiroVencimento: "2026-10-05" });
    const parcelas = await purchaseEntries(id);

    // paga as duas primeiras
    for (const p of parcelas.slice(0, 2)) {
      await insert(
        `INSERT INTO expenses (date, category, description, amount_cents, entry_id, purchase_id)
         VALUES (?,?,?,?,?,?)`,
        ["2026-10-05", "Compras", "parcela", p.amount_cents, p.id, id],
      );
    }

    const pago = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM expenses WHERE purchase_id = ?`, [id]);
    const previsto = await scalar<number>(
      `SELECT COALESCE(SUM(amount_cents),0) FROM financial_entries WHERE purchase_id = ?`,
      [id],
    );
    assert.equal(pago, 100000, "caixa: R$ 1.000");
    assert.equal(previsto - pago, 400000, "a pagar: R$ 4.000");
  });

  it("recusa refazer o parcelamento de uma compra ja paga", async () => {
    const id = await criarCompra([{ product_id: mesa, qty: 50, unit_price_cents: 10000 }]);
    await syncPurchaseEntries(id, { parcelas: 10, primeiroVencimento: "2026-10-05" });
    const parcelas = await purchaseEntries(id);
    await insert(
      `INSERT INTO expenses (date, category, description, amount_cents, entry_id, purchase_id) VALUES (?,?,?,?,?,?)`,
      ["2026-10-05", "Compras", "parcela", parcelas[0].amount_cents, parcelas[0].id, id],
    );

    const erro = await syncPurchaseEntries(id, { parcelas: 4, primeiroVencimento: "2026-11-05" });
    assert.match(erro ?? "", /parcela paga/i);
    assert.equal((await purchaseEntries(id)).length, 10, "as parcelas antigas continuam intactas");
  });
});

describe("totais da compra", () => {
  beforeEach(cenario);

  it("desconto geral abate do total", async () => {
    const id = await criarCompra([{ product_id: mesa, qty: 5, unit_price_cents: 10000 }], {
      afetaEstoque: true,
      desconto: 5000,
    });
    const compra = await one<any>(`SELECT items_cents, total_cents FROM purchases WHERE id = ?`, [id]);
    assert.equal(compra.items_cents, 50000);
    assert.equal(compra.total_cents, 45000);
  });

  it("os itens guardam o produto do estoque, sem duplicar cadastro", async () => {
    const id = await criarCompra([{ product_id: mesa, qty: 5, unit_price_cents: 10000 }]);
    const itens = await purchaseItems(id);
    assert.equal(itens[0].product_id, mesa);
    assert.equal(itens[0].product_name, "Mesa");
  });
});
