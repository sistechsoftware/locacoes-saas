/**
 * Itens nos cartoes de reserva, com o SQL real da aplicacao.
 *
 * O cartao precisa mostrar o produto comercial que o cliente contratou, nunca
 * uma contagem generica de pecas, e a composicao do kit e apoio de separacao.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { insert } from "../src/lib/db.ts";
import { itemsForReservations, pecasFisicas } from "../src/lib/reservations.ts";

let cliente = 0;
let MESA = 0;
let CADEIRA = 0;
let FORRO = 0;
let BISTRO = 0;
let KIT = 0;
let KIT1x1 = 0;

async function cenario() {
  createTestDb();
  cliente = await insert(`INSERT INTO customers (name) VALUES ('Cliente Teste')`);
  MESA = await produto("MESA", "Mesa plastica", "simples", 20);
  CADEIRA = await produto("CAD", "Cadeira plastica", "simples", 80);
  FORRO = await produto("FRM", "Forro de mesa", "simples", 50);
  BISTRO = await produto("BIS", "Cadeira Bistro", "simples", 30);
  KIT = await produto("KIT-MC4", "Kit Mesa + 4 Cadeiras", "kit", 0);
  KIT1x1 = await produto("KIT-MC1", "Kit Mesa + Cadeira", "kit", 0);
  await componente(KIT, MESA, 1);
  await componente(KIT, CADEIRA, 4);
  await componente(KIT1x1, MESA, 1);
  await componente(KIT1x1, CADEIRA, 1);
}

async function produto(code: string, name: string, kind: string, qty: number) {
  return await insert(
    `INSERT INTO products (code, name, kind, total_qty, rent_price_cents) VALUES (?,?,?,?,0)`,
    [code, name, kind, qty],
  );
}

async function componente(kit: number, parte: number, quantidade: number) {
  await insert(
    `INSERT INTO product_components (parent_product_id, component_product_id, quantity) VALUES (?,?,?)`,
    [kit, parte, quantidade],
  );
}

async function reserva(numero = "LIMA-001") {
  return await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, total_cents)
     VALUES (?,?,'confirmada','2026-10-10',0)`,
    [numero, cliente],
  );
}

/** Lanca um item na reserva, gravando a composicao como a aplicacao faz. */
async function lancar(
  reservationId: number,
  productId: number,
  qty: number,
  componentes: { productId: number; porUnidade: number }[] = [],
) {
  const itemId = await insert(
    `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents, subtotal_cents)
     VALUES (?,?,?,0,0)`,
    [reservationId, productId, qty],
  );
  const linhas =
    componentes.length > 0
      ? componentes
      : [{ productId, porUnidade: 1 }]; // produto simples expande 1:1 para ele mesmo
  for (const c of linhas) {
    await insert(
      `INSERT INTO reservation_item_components (reservation_id, reservation_item_id, product_id, qty_per_unit, qty)
       VALUES (?,?,?,?,?)`,
      [reservationId, itemId, c.productId, c.porUnidade, c.porUnidade * qty],
    );
  }
  return itemId;
}

describe("produto comercial no cartao", () => {
  beforeEach(cenario);

  it("5 kits aparecem como 5x o kit, nao como quantidade de pecas", async () => {
    const id = await reserva();
    await lancar(id, KIT1x1, 5, [
      { productId: MESA, porUnidade: 1 },
      { productId: CADEIRA, porUnidade: 1 },
    ]);

    const itens = (await itemsForReservations([id])).get(id)!;
    assert.equal(itens.length, 1);
    assert.equal(itens[0].qty, 5);
    assert.equal(itens[0].name, "Kit Mesa + Cadeira");
    assert.equal(itens[0].kind, "kit");
  });

  it("45 kits de 1 mesa + 4 cadeiras mostram 45 mesas e 180 cadeiras", async () => {
    const id = await reserva();
    await lancar(id, KIT, 45, [
      { productId: MESA, porUnidade: 1 },
      { productId: CADEIRA, porUnidade: 4 },
    ]);

    const [item] = (await itemsForReservations([id])).get(id)!;
    assert.equal(item.qty, 45, "a quantidade comercial continua 45 kits");
    assert.deepEqual(
      item.componentes.map((c) => `${c.qty}x ${c.name}`),
      ["45x Mesa plastica", "180x Cadeira plastica"],
    );
    assert.equal(pecasFisicas([item]), 225, "225 pecas saem do galpao");
  });

  it("kit com avulsos mantem nome e quantidade exatos de cada linha", async () => {
    const id = await reserva();
    await lancar(id, KIT1x1, 2, [
      { productId: MESA, porUnidade: 1 },
      { productId: CADEIRA, porUnidade: 1 },
    ]);
    await lancar(id, BISTRO, 4);
    await lancar(id, FORRO, 3);

    const itens = (await itemsForReservations([id])).get(id)!;
    assert.deepEqual(
      itens.map((i) => `${i.qty}x ${i.name}`),
      ["2x Kit Mesa + Cadeira", "4x Cadeira Bistro", "3x Forro de mesa"],
    );
  });

  it("so avulsos nao viram um total generico", async () => {
    const id = await reserva();
    await lancar(id, BISTRO, 2);
    await lancar(id, MESA, 1);
    await lancar(id, FORRO, 3);

    const itens = (await itemsForReservations([id])).get(id)!;
    assert.equal(itens.length, 3, "tres produtos, nao '6 itens'");
    assert.equal(pecasFisicas(itens), 6);
  });

  it("avulso nao repete a si mesmo como composicao", async () => {
    const id = await reserva();
    await lancar(id, BISTRO, 4);

    const [item] = (await itemsForReservations([id])).get(id)!;
    assert.deepEqual(item.componentes, [], "2x Mesa - composicao: 2x Mesa nao ajuda ninguem");
  });

  it("kits diferentes ficam separados, cada um com a sua composicao", async () => {
    const id = await reserva();
    await lancar(id, KIT1x1, 5, [
      { productId: MESA, porUnidade: 1 },
      { productId: CADEIRA, porUnidade: 1 },
    ]);
    await lancar(id, KIT, 3, [
      { productId: MESA, porUnidade: 1 },
      { productId: CADEIRA, porUnidade: 4 },
    ]);

    const itens = (await itemsForReservations([id])).get(id)!;
    assert.equal(itens.length, 2);
    assert.equal(pecasFisicas([itens[0]]), 10, "5 mesas + 5 cadeiras");
    assert.equal(pecasFisicas([itens[1]]), 15, "3 mesas + 12 cadeiras");
  });
});

describe("listagem", () => {
  beforeEach(cenario);

  it("uma consulta serve varias reservas sem misturar os itens", async () => {
    const a = await reserva("LIMA-001");
    const b = await reserva("LIMA-002");
    await lancar(a, KIT, 2, [
      { productId: MESA, porUnidade: 1 },
      { productId: CADEIRA, porUnidade: 4 },
    ]);
    await lancar(b, FORRO, 7);

    const mapa = await itemsForReservations([a, b]);
    assert.equal(mapa.get(a)!.length, 1);
    assert.equal(mapa.get(a)![0].name, "Kit Mesa + 4 Cadeiras");
    assert.equal(mapa.get(b)![0].name, "Forro de mesa");
    assert.equal(mapa.get(b)![0].qty, 7);
  });

  it("reserva sem itens nao quebra a listagem", async () => {
    const id = await reserva();
    const mapa = await itemsForReservations([id]);
    assert.equal(mapa.get(id), undefined);
  });

  it("lista vazia nao consulta o banco", async () => {
    const mapa = await itemsForReservations([]);
    assert.equal(mapa.size, 0);
  });

  it("a composicao gravada vale mesmo se a receita do kit mudar depois", async () => {
    const id = await reserva();
    await lancar(id, KIT, 10, [
      { productId: MESA, porUnidade: 1 },
      { productId: CADEIRA, porUnidade: 4 },
    ]);
    // kit passa a levar 6 cadeiras; a reserva antiga separou 4
    await insert(
      `INSERT INTO product_components (parent_product_id, component_product_id, quantity)
       VALUES (?,?,6) ON CONFLICT(parent_product_id, component_product_id)
       DO UPDATE SET quantity = 6`,
      [KIT, CADEIRA],
    );

    const [item] = (await itemsForReservations([id])).get(id)!;
    assert.equal(
      item.componentes.find((c) => c.name === "Cadeira plastica")!.qty,
      40,
      "historico preservado: 40 cadeiras, nao 60",
    );
  });
});
