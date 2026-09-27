/**
 * Promocoes com o SQL real: carga por produto, integracao com o preco da linha,
 * frete, desconto manual e congelamento de documentos ja salvos.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { all, insert, one, run } from "../src/lib/db.ts";
import { precoUnitario } from "../src/lib/promocoes.ts";
import { precoSugerido, promocoesAtivasPorProduto, promocoesVigentes } from "../src/lib/promocoes-db.ts";
import { sellableProducts } from "../src/lib/stock.ts";
import { recalcReservation } from "../src/lib/reservations.ts";

const NORMAL = 2000;
let KIT = 0;
let FORRO = 0;
let cliente = 0;

async function cenario() {
  createTestDb();
  cliente = await insert(`INSERT INTO customers (name) VALUES ('Cliente Teste')`);
  KIT = await insert(
    `INSERT INTO products (code, name, kind, total_qty, rent_price_cents) VALUES ('KIT','Kit Mesa + 4 Cadeiras','kit',0,?)`,
    [NORMAL],
  );
  FORRO = await insert(
    `INSERT INTO products (code, name, kind, total_qty, rent_price_cents) VALUES ('FRM','Forro de mesa','simples',50,500)`,
  );
}

async function promocao(opts: { produto?: number; ativa?: boolean; inicio?: string | null; fim?: string | null } = {}) {
  const id = await insert(
    `INSERT INTO promotions (product_id, name, active, starts_on, ends_on) VALUES (?,?,?,?,?)`,
    [opts.produto ?? KIT, "Promo kits", opts.ativa === false ? 0 : 1, opts.inicio ?? null, opts.fim ?? null],
  );
  for (const f of [
    { min: 1, max: 4, preco: 1500 },
    { min: 5, max: 14, preco: 1300 },
    { min: 15, max: null, preco: 1000 },
  ]) {
    await insert(
      `INSERT INTO promotion_tiers (promotion_id, min_qty, max_qty, unit_price_cents) VALUES (?,?,?,?)`,
      [id, f.min, f.max, f.preco],
    );
  }
  return id;
}

describe("carga das promocoes", () => {
  beforeEach(cenario);

  it("o produto vendavel ja vem com a promocao junto", async () => {
    await promocao();
    const produtos = await sellableProducts();
    const kit = produtos.find((p: any) => p.id === KIT)!;
    assert.equal(kit.promocao?.tiers.length, 3);
    assert.equal(kit.rent_price_cents, NORMAL, "o preco normal continua intacto no cadastro");
  });

  it("produto sem promocao vem com promocao nula", async () => {
    await promocao();
    const produtos = await sellableProducts();
    assert.equal(produtos.find((p: any) => p.id === FORRO)!.promocao, null);
  });

  it("promocao desativada nao viaja para o formulario", async () => {
    await promocao({ ativa: false });
    assert.equal((await promocoesAtivasPorProduto()).size, 0);
  });

  it("promocao sem faixa nenhuma e ignorada", async () => {
    await insert(`INSERT INTO promotions (product_id, name, active) VALUES (?,'Vazia',1)`, [KIT]);
    assert.equal((await promocoesAtivasPorProduto()).size, 0);
  });

  it("as faixas chegam ordenadas mesmo gravadas fora de ordem", async () => {
    const id = await insert(`INSERT INTO promotions (product_id, name, active) VALUES (?,'Fora de ordem',1)`, [KIT]);
    for (const f of [
      { min: 15, max: null, preco: 1000 },
      { min: 1, max: 4, preco: 1500 },
    ]) {
      await insert(
        `INSERT INTO promotion_tiers (promotion_id, min_qty, max_qty, unit_price_cents) VALUES (?,?,?,?)`,
        [id, f.min, f.max, f.preco],
      );
    }
    const p = (await promocoesAtivasPorProduto()).get(KIT)!;
    assert.deepEqual(p.tiers.map((t) => t.min_qty), [1, 15]);
  });
});

describe("vigencia por data no banco", () => {
  beforeEach(cenario);

  it("promocao de setembro nao aparece em outubro", async () => {
    await promocao({ inicio: "2026-09-01", fim: "2026-09-30" });
    assert.ok((await promocoesVigentes("2026-09-15")).has(KIT));
    assert.ok(!(await promocoesVigentes("2026-10-01")).has(KIT));
  });

  it("preco sugerido pelo servidor bate com a regra", async () => {
    await promocao();
    assert.equal((await precoSugerido(KIT, 15, "2026-09-15")).unit_price_cents, 1000);
    assert.equal((await precoSugerido(KIT, 3, "2026-09-15")).unit_price_cents, 1500);
    assert.equal((await precoSugerido(FORRO, 100, "2026-09-15")).unit_price_cents, 500, "sem promocao, preco normal");
  });
});

describe("valor da reserva", () => {
  beforeEach(cenario);

  async function reservaCom(itens: { produto: number; qty: number; preco: number; desconto?: number }[], extras: {
    frete?: number;
    desconto?: number;
  } = {}) {
    const id = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, freight_cents, discount_cents, total_cents)
       VALUES (?,?,'confirmada','2026-09-20',?,?,0)`,
      [`R-${Math.random().toString(36).slice(2, 8)}`, cliente, extras.frete ?? 0, extras.desconto ?? 0],
    );
    for (const i of itens) {
      await insert(
        `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents, discount_cents)
         VALUES (?,?,?,?,?)`,
        [id, i.produto, i.qty, i.preco, i.desconto ?? 0],
      );
    }
    await recalcReservation(id);
    return await one<any>(`SELECT * FROM reservations WHERE id = ?`, [id]);
  }

  it("15 kits ao preco promocional somam R$ 150", async () => {
    const p = await precoSugerido(KIT, 15, "2026-09-20");
    await promocao();
    const promo = await precoSugerido(KIT, 15, "2026-09-20");
    const r = await reservaCom([{ produto: KIT, qty: 15, preco: promo.unit_price_cents }]);
    assert.equal(p.unit_price_cents, NORMAL, "sem promocao seria o preco normal");
    assert.equal(r.items_cents, 15000);
    assert.equal(r.total_cents, 15000);
  });

  it("a promocao nao encosta no frete", async () => {
    await promocao();
    const promo = await precoSugerido(KIT, 15, "2026-09-20");
    const r = await reservaCom([{ produto: KIT, qty: 15, preco: promo.unit_price_cents }], { frete: 5000 });
    assert.equal(r.items_cents, 15000, "so os itens ficam promocionais");
    assert.equal(r.freight_cents, 5000, "frete intacto");
    assert.equal(r.total_cents, 20000, "R$ 150 + R$ 50 = R$ 200");
  });

  it("desconto manual continua funcionando por cima do preco promocional", async () => {
    await promocao();
    const promo = await precoSugerido(KIT, 15, "2026-09-20");
    const r = await reservaCom([{ produto: KIT, qty: 15, preco: promo.unit_price_cents, desconto: 1000 }], {
      frete: 5000,
      desconto: 2000,
    });
    assert.equal(r.items_cents, 14000, "R$ 150 menos R$ 10 de desconto na linha");
    assert.equal(r.total_cents, 17000, "menos R$ 20 de desconto geral, mais R$ 50 de frete");
  });

  it("itens com e sem promocao convivem na mesma reserva", async () => {
    await promocao();
    const kit = await precoSugerido(KIT, 15, "2026-09-20");
    const forro = await precoSugerido(FORRO, 15, "2026-09-20");
    const r = await reservaCom([
      { produto: KIT, qty: 15, preco: kit.unit_price_cents },
      { produto: FORRO, qty: 15, preco: forro.unit_price_cents },
    ]);
    assert.equal(r.items_cents, 15000 + 7500, "kits promocionais mais forros ao preco normal");
  });
});

describe("documentos ja salvos nao mudam de valor", () => {
  beforeEach(cenario);

  it("alterar a promocao depois nao reescreve a reserva registrada", async () => {
    const promoId = await promocao();
    const antes = await precoSugerido(KIT, 10, "2026-09-20");
    assert.equal(antes.unit_price_cents, 1300);

    const id = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, total_cents)
       VALUES ('LIMA-900',?,'confirmada','2026-09-20',0)`,
      [cliente],
    );
    await insert(
      `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents) VALUES (?,?,10,?)`,
      [id, KIT, antes.unit_price_cents],
    );
    await recalcReservation(id);

    // a empresa baixa o preco da faixa depois da reserva fechada
    await run(`UPDATE promotion_tiers SET unit_price_cents = 1200 WHERE promotion_id = ? AND min_qty = 5`, [promoId]);
    assert.equal((await precoSugerido(KIT, 10, "2026-09-20")).unit_price_cents, 1200, "regra nova vale para o proximo");

    const salva = await one<any>(`SELECT * FROM reservations WHERE id = ?`, [id]);
    const [item] = await all<any>(`SELECT * FROM reservation_items WHERE reservation_id = ?`, [id]);
    assert.equal(item.unit_price_cents, 1300, "a linha guarda o preco do dia em que foi fechada");
    assert.equal(salva.total_cents, 13000, "o total nao foi reescrito");
  });

  it("excluir a promocao nao altera documento nenhum", async () => {
    const promoId = await promocao();
    const id = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, total_cents)
       VALUES ('LIMA-901',?,'confirmada','2026-09-20',0)`,
      [cliente],
    );
    await insert(
      `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents) VALUES (?,?,15,1000)`,
      [id, KIT],
    );
    await recalcReservation(id);

    await run(`DELETE FROM promotions WHERE id = ?`, [promoId]);
    const salva = await one<any>(`SELECT * FROM reservations WHERE id = ?`, [id]);
    assert.equal(salva.total_cents, 15000);
    assert.equal(
      (await all<any>(`SELECT * FROM promotion_tiers WHERE promotion_id = ?`, [promoId])).length,
      0,
      "as faixas somem junto com a promocao",
    );
  });
});

describe("mudanca de quantidade refaz o preco", () => {
  beforeEach(cenario);

  it("subir e descer de faixa devolve o preco certo", async () => {
    await promocao();
    const p = (await promocoesAtivasPorProduto()).get(KIT);
    const em = (qty: number) => precoUnitario(NORMAL, p, qty, "2026-09-20").unit_price_cents;
    assert.equal(em(5), 1300);
    assert.equal(em(15), 1000, "subiu de faixa");
    assert.equal(em(4), 1500, "voltou para a faixa anterior");
  });
});
