/**
 * Calendario de disponibilidade: kits e avulsos, com o SQL real da aplicacao.
 *
 * Cenario base: 20 mesas, 80 cadeiras, 50 forros, kit = 1 mesa + 4 cadeiras.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { insert, run } from "../src/lib/db.ts";
import { availabilityByCategory } from "../src/lib/stock.ts";

let cliente = 0;
let MESA = 0;
let CADEIRA = 0;
let FORRO = 0;
let KIT = 0;
let KIT6 = 0;

const DE = "2026-10-10T00:00";
const ATE = "2026-10-10T23:59";

async function cenario(mesas = 20, cadeiras = 80, forros = 50) {
  createTestDb();
  cliente = await insert(`INSERT INTO customers (name) VALUES ('Cliente Teste')`);
  MESA = await produto("MESA", "Mesa plastica", "simples", mesas);
  CADEIRA = await produto("CAD", "Cadeira plastica", "simples", cadeiras);
  FORRO = await produto("FRM", "Forro de mesa", "simples", forros);
  KIT = await produto("KIT-MC4", "Kit Mesa + 4 Cadeiras", "kit", 0);
  KIT6 = await produto("KIT-MC6", "Kit Mesa + 6 Cadeiras", "kit", 0);
  await componente(KIT, MESA, 1);
  await componente(KIT, CADEIRA, 4);
  await componente(KIT6, MESA, 1);
  await componente(KIT6, CADEIRA, 6);
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

/** Reserva confirmada ocupando o dia todo, com a composicao gravada. */
async function reservar(
  productId: number,
  qty: number,
  componentes: { productId: number; porUnidade: number }[] = [],
  dia = "2026-10-10",
) {
  const id = await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, delivery_at, pickup_at, total_cents)
     VALUES (?,?,'confirmada',?,?,?,0)`,
    [`R-${Math.random().toString(36).slice(2, 8)}`, cliente, dia, `${dia}T06:00`, `${dia}T23:00`],
  );
  const itemId = await insert(
    `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents, subtotal_cents)
     VALUES (?,?,?,0,0)`,
    [id, productId, qty],
  );
  const linhas = componentes.length > 0 ? componentes : [{ productId, porUnidade: 1 }];
  for (const c of linhas) {
    await insert(
      `INSERT INTO reservation_item_components (reservation_id, reservation_item_id, product_id, qty_per_unit, qty)
       VALUES (?,?,?,?,?)`,
      [id, itemId, c.productId, c.porUnidade, c.porUnidade * qty],
    );
  }
  return id;
}

/** Junta tudo num mapa por nome, do jeito que a tela le. */
async function disponibilidade(de = DE, ate = ATE) {
  const grupos = await availabilityByCategory(de, ate);
  const todos = grupos.flatMap((g) => g.products);
  return {
    todos,
    kits: todos.filter((p) => p.kind === "kit"),
    avulsos: todos.filter((p) => p.kind !== "kit"),
    por: (nome: string) => todos.find((p) => p.name === nome)!,
  };
}

describe("kits e avulsos separados", () => {
  beforeEach(() => cenario());

  it("20 mesas, 80 cadeiras e 50 forros dao 20 kits, com os produtos separados", async () => {
    const d = await disponibilidade();
    assert.equal(d.por("Kit Mesa + 4 Cadeiras").available, 20);
    assert.equal(d.por("Mesa plastica").available, 20);
    assert.equal(d.por("Cadeira plastica").available, 80);
    assert.equal(d.por("Forro de mesa").available, 50);
    assert.equal(d.avulsos.length, 3, "tres produtos avulsos, nunca um total de 150");
  });

  it("o kit carrega a composicao para a tela mostrar", async () => {
    const d = await disponibilidade();
    assert.deepEqual(
      d.por("Kit Mesa + 4 Cadeiras").components?.map((c) => `${c.quantity}x ${c.name}`),
      ["1x Mesa plastica", "4x Cadeira plastica"],
    );
  });

  it("nenhum total de categoria soma kit com produto fisico", async () => {
    const grupos = await availabilityByCategory(DE, ATE);
    for (const g of grupos) {
      const fisicos = g.products.filter((p) => p.kind !== "kit");
      assert.equal(
        g.available,
        fisicos.reduce((s, p) => s + Math.max(0, p.available), 0),
        `categoria ${g.category} nao pode contar capacidade de kit como estoque`,
      );
    }
  });
});

describe("capacidade pelo componente mais escasso", () => {
  it("20 mesas e 60 cadeiras dao 15 kits", async () => {
    await cenario(20, 60);
    const d = await disponibilidade();
    assert.equal(d.por("Kit Mesa + 4 Cadeiras").available, 15);
  });

  it("20 mesas e 70 cadeiras dao 17 kits", async () => {
    await cenario(20, 70);
    const d = await disponibilidade();
    assert.equal(d.por("Kit Mesa + 4 Cadeiras").available, 17);
  });

  it("sem cadeiras nao ha kit, mas as mesas continuam disponiveis", async () => {
    await cenario(20, 0);
    const d = await disponibilidade();
    assert.equal(d.por("Kit Mesa + 4 Cadeiras").available, 0);
    assert.equal(d.por("Mesa plastica").available, 20);
  });
});

describe("estoque compartilhado", () => {
  beforeEach(() => cenario());

  it("reservar 5 kits baixa 5 mesas e 20 cadeiras e recalcula a capacidade", async () => {
    await reservar(KIT, 5, [
      { productId: MESA, porUnidade: 1 },
      { productId: CADEIRA, porUnidade: 4 },
    ]);
    const d = await disponibilidade();
    assert.equal(d.por("Mesa plastica").available, 15);
    assert.equal(d.por("Cadeira plastica").available, 60);
    assert.equal(d.por("Kit Mesa + 4 Cadeiras").available, 15);
  });

  it("reservar 7 mesas avulsas deixa 13 disponiveis", async () => {
    await reservar(MESA, 7);
    const d = await disponibilidade();
    assert.equal(d.por("Mesa plastica").available, 13);
  });

  it("mesa reservada como avulsa derruba a capacidade do kit, sem dupla baixa", async () => {
    await reservar(MESA, 8);
    const d = await disponibilidade();
    assert.equal(d.por("Mesa plastica").available, 12);
    assert.equal(d.por("Cadeira plastica").available, 80, "cadeira nao foi tocada");
    assert.equal(d.por("Kit Mesa + 4 Cadeiras").available, 12, "limitado pelas mesas");
  });

  it("kits que dividem componentes nao representam disponibilidade somavel", async () => {
    const d = await disponibilidade();
    const kit4 = d.por("Kit Mesa + 4 Cadeiras").available;
    const kit6 = d.por("Kit Mesa + 6 Cadeiras").available;
    assert.equal(kit4, 20);
    assert.equal(kit6, 13);
    assert.ok(
      kit4 + kit6 > d.por("Mesa plastica").available,
      "somar os dois kits daria 33, acima das 20 mesas: por isso a tela nunca soma",
    );
  });
});

describe("produto fora de kit e datas", () => {
  beforeEach(() => cenario());

  it("forro nao participa de kit e aparece inteiro nos avulsos", async () => {
    const d = await disponibilidade();
    const forro = d.por("Forro de mesa");
    assert.equal(forro.available, 50);
    assert.equal(forro.kind, "simples");
  });

  it("reserva em outro dia nao afeta a data consultada", async () => {
    await reservar(
      KIT,
      10,
      [
        { productId: MESA, porUnidade: 1 },
        { productId: CADEIRA, porUnidade: 4 },
      ],
      "2026-11-20",
    );
    const livre = await disponibilidade();
    assert.equal(livre.por("Kit Mesa + 4 Cadeiras").available, 20, "10/10 continua livre");

    const ocupado = await disponibilidade("2026-11-20T00:00", "2026-11-20T23:59");
    assert.equal(ocupado.por("Kit Mesa + 4 Cadeiras").available, 10);
    assert.equal(ocupado.por("Mesa plastica").available, 10);
  });

  it("reserva cancelada nao ocupa estoque", async () => {
    const id = await reservar(KIT, 5, [
      { productId: MESA, porUnidade: 1 },
      { productId: CADEIRA, porUnidade: 4 },
    ]);
    await run(`UPDATE reservations SET status = 'cancelada' WHERE id = ?`, [id]);
    const d = await disponibilidade();
    assert.equal(d.por("Mesa plastica").available, 20);
    assert.equal(d.por("Kit Mesa + 4 Cadeiras").available, 20);
  });
});
