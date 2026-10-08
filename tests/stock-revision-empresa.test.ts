/**
 * Regressão do bug de staging: "O estoque ou a reserva mudou durante a
 * verificacao. Nada foi alterado; confira os dados e tente novamente."
 *
 * Causa: a 0027 virou stock_revision em uma linha POR EMPRESA e semeou só as
 * empresas que existiam na época. A empresa nova (onboarding em
 * criarEmpresaComTrial) nascia SEM linha — stockVersion() devolve 0 (o
 * `scalar` do db.ts devolve 0 quando a linha não existe), o CAS compara
 * `NULL = 0` dentro do CASE, rende 0 e o CHECK `stock_version_matches` de
 * stock_write_guard dispara STOCK_CHANGED em toda escrita de estoque.
 * Clientes e produtos nasciam normalmente porque os triggers de revisão fazem
 * `UPDATE stock_revision ... WHERE id = NEW.company_id`, que vira no-op.
 *
 * Correção: migrations/0035_stock_revision_company.sql (backfill + trigger
 * AFTER INSERT ON companies).
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, type FakeD1 } from "./helpers/d1";
import { all, insert, one, run, scalar } from "../src/lib/db";
import { JANELA, montarCenario, resetSequencia } from "./helpers/fixtures";
import { STOCK_CHANGED, commitStockBatch, stockVersion, writeRental } from "../src/lib/stock-write";

const MIGRACAO = path.resolve("migrations", "0035_stock_revision_company.sql");

let db: FakeD1;
let c: Awaited<ReturnType<typeof montarCenario>>;

beforeEach(async () => {
  db = createTestDb();
  resetSequencia();
  c = await montarCenario();
});

/** Empresa nova fora da 0027: grava em companies e segue sem tocar em stock_revision. */
async function novaEmpresa(nome: string) {
  const id = await insert(`INSERT INTO companies (name, active) VALUES (?, 1)`, [nome]);
  const produtoId = await insert(
    `INSERT INTO products (code, name, kind, total_qty, rent_price_cents, company_id) VALUES (?,?, 'simples', 5, 5000, ?)`,
    [`P-${id}`, nome, id],
  );
  const clienteId = await insert(`INSERT INTO customers (name, company_id) VALUES (?, ?)`, [`Cliente ${nome}`, id]);
  return { id, produtoId, clienteId };
}

const header = (clienteId: number) => ({
  customer_id: clienteId,
  status: "pre_reserva",
  event_date: "2026-09-10",
  delivery_at: JANELA.from,
  pickup_at: JANELA.to,
});

/** Simula um banco em que a 0035 ainda não rodou (estado do staging). */
async function apagarRevisao(companyId: number) {
  await run(`DELETE FROM stock_revision WHERE id = ?`, [companyId]);
}

describe("estado anterior à 0035 — o que o staging reportava", () => {
  it("empresa sem linha: stockVersion devolve 0 e a criação de reserva falha com STOCK_CHANGED", async () => {
    const e = await novaEmpresa("Locacoes Motta");
    await apagarRevisao(e.id);
    assert.equal(await one(`SELECT revision FROM stock_revision WHERE id = ?`, [e.id]), undefined);
    assert.equal(await stockVersion(e.id), 0);

    await assert.rejects(
      writeRental(e.id, await stockVersion(e.id), header(e.clienteId), [{ product_id: e.produtoId, qty: 1 }]),
      { message: STOCK_CHANGED },
    );
    // Nada foi alterado, como a tela prometia.
    assert.equal(await scalar(`SELECT COUNT(*) FROM reservations`), 0);
    assert.equal(await scalar(`SELECT COUNT(*) FROM reservation_items`), 0);
  });

  it("a 0035 recupera a empresa pelo backfill e a reserva passa a ser gravada", async () => {
    const e = await novaEmpresa("Locacoes Motta");
    await apagarRevisao(e.id);
    await assert.rejects(
      writeRental(e.id, await stockVersion(e.id), header(e.clienteId), [{ product_id: e.produtoId, qty: 1 }]),
      { message: STOCK_CHANGED },
    );

    db.sqlite.exec(fs.readFileSync(MIGRACAO, "utf8"));

    assert.deepEqual(await one(`SELECT revision FROM stock_revision WHERE id = ?`, [e.id]), { revision: 0 });
    const { id } = await writeRental(e.id, await stockVersion(e.id), header(e.clienteId), [{ product_id: e.produtoId, qty: 2 }]);
    assert.ok(id > 0);
    assert.equal(await scalar(`SELECT COUNT(*) FROM reservations WHERE id = ?`, [id]), 1);
    assert.equal(await scalar(`SELECT qty FROM reservation_items WHERE reservation_id = ?`, [id]), 2);
  });
});

describe("trigger da 0035 — empresas criadas a partir de agora", () => {
  it("empresa inserida em companies nasce com a sua linha de revisão", async () => {
    const empresaId = await insert(`INSERT INTO companies (name, active) VALUES ('Empresa Trigger', 1)`);
    assert.deepEqual(await one(`SELECT revision FROM stock_revision WHERE id = ?`, [empresaId]), { revision: 0 });
    const e = await novaEmpresa("Empresa Trigger Products");
    // escritas da própria empresa incrementam a SUA revisão (triggers da 0027)
    assert.ok((await scalar(`SELECT revision FROM stock_revision WHERE id = ?`, [e.id])) as number > 0);
    // Continua valendo a guarda: sem a linha o CAS falharia, com ela grava.
    const { id } = await writeRental(e.id, await stockVersion(e.id), header(e.clienteId), [{ product_id: e.produtoId, qty: 1 }]);
    assert.equal(await scalar(`SELECT COUNT(*) FROM reservations WHERE id = ?`, [id]), 1);
  });

  it("a migration é idempotente e preserva a revisão das empresas que já têm linha", async () => {
    await run(`UPDATE stock_revision SET revision = 42 WHERE id = 1`);
    const antes = fs.readFileSync(MIGRACAO, "utf8");
    db.sqlite.exec(antes);
    db.sqlite.exec(antes);
    assert.deepEqual(await one(`SELECT revision FROM stock_revision WHERE id = 1`), { revision: 42 });
    const semLinha = await all(
      `SELECT id FROM companies WHERE id NOT IN (SELECT id FROM stock_revision)`,
    );
    assert.deepEqual(semLinha, []);
  });

  it("corrida de verdade continua barrada pelo CAS — a 0035 não afrouxou a guarda", async () => {
    const e = await novaEmpresa("Empresa Corrida");
    const versao = await stockVersion(e.id);
    await run(`UPDATE products SET total_qty = 6 WHERE id = ?`, [e.produtoId]); // trigger incrementa a revisão
    await assert.rejects(commitStockBatch(e.id, versao, []), { message: STOCK_CHANGED });
    assert.equal(await scalar(`SELECT COUNT(*) FROM reservations`), 0);

    const nova = await stockVersion(e.id);
    await commitStockBatch(e.id, nova, []);
    assert.deepEqual(await one(`SELECT revision FROM stock_revision WHERE id = ?`, [e.id]), { revision: nova });
  });
});

describe("cenario padrão dos testes continua de pé", () => {
  it("empresa 1 grava reserva com a revisão já existente", async () => {
    const { id } = await writeRental(1, await stockVersion(1), header(c.clienteId), [{ product_id: c.kitId, qty: 5 }]);
    assert.equal(await scalar(`SELECT COUNT(*) FROM reservation_items WHERE reservation_id = ?`, [id]), 1);
  });
});
