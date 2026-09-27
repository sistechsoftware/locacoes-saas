/** Cenario base dos testes: 20 mesas, 80 cadeiras e um kit 1 mesa + 4 cadeiras. */
import { insert, run } from "../../src/lib/db";
import { rebuildReservationComponents } from "../../src/lib/stock";
import { recalcReservation } from "../../src/lib/reservations";

export const JANELA = { from: "2026-09-10T08:00", to: "2026-09-11T10:00" };

export type Cenario = {
  mesaId: number;
  cadeiraId: number;
  kitId: number;
  clienteId: number;
};

export async function montarCenario(mesas = 20, cadeiras = 80): Promise<Cenario> {
  await run(`INSERT INTO categories (name) VALUES ('Mesas'), ('Cadeiras'), ('Outros')`);

  const mesaId = await insert(
    `INSERT INTO products (code, name, kind, total_qty, rent_price_cents) VALUES ('MESA','Mesa','simples',?,8000)`,
    [mesas],
  );
  const cadeiraId = await insert(
    `INSERT INTO products (code, name, kind, total_qty, rent_price_cents) VALUES ('CAD','Cadeira','simples',?,3900)`,
    [cadeiras],
  );
  const kitId = await insert(
    `INSERT INTO products (code, name, kind, total_qty, rent_price_cents) VALUES ('KIT','Kit Mesa + 4 Cadeiras','kit',0,20000)`,
  );
  await insert(`INSERT INTO product_components (parent_product_id, component_product_id, quantity) VALUES (?,?,1)`, [
    kitId,
    mesaId,
  ]);
  await insert(`INSERT INTO product_components (parent_product_id, component_product_id, quantity) VALUES (?,?,4)`, [
    kitId,
    cadeiraId,
  ]);

  const clienteId = await insert(`INSERT INTO customers (name) VALUES ('Cliente Teste')`);
  return { mesaId, cadeiraId, kitId, clienteId };
}

let sequencia = 0;

/** Cria uma reserva confirmada com as linhas comerciais informadas. */
export async function criarReserva(
  clienteId: number,
  linhas: { product_id: number; qty: number }[],
  status = "confirmada",
  janela = JANELA,
): Promise<number> {
  sequencia += 1;
  const id = await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, delivery_at, pickup_at)
     VALUES (?,?,?,?,?,?)`,
    [
      `LIMA-${String(sequencia).padStart(3, "0")}`,
      clienteId,
      status,
      janela.from.slice(0, 10),
      janela.from,
      janela.to,
    ],
  );
  for (const l of linhas) {
    await insert(`INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents) VALUES (?,?,?,0)`, [
      id,
      l.product_id,
      l.qty,
    ]);
  }
  await rebuildReservationComponents(id);
  await recalcReservation(id);
  return id;
}

/** Altera as quantidades de uma reserva existente, como faz updateReservation. */
export async function alterarReserva(id: number, linhas: { product_id: number; qty: number }[]) {
  await run(`DELETE FROM reservation_items WHERE reservation_id = ?`, [id]);
  for (const l of linhas) {
    await insert(`INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents) VALUES (?,?,?,0)`, [
      id,
      l.product_id,
      l.qty,
    ]);
  }
  await rebuildReservationComponents(id);
  await recalcReservation(id);
}

export async function cancelarReserva(id: number) {
  await run(`UPDATE reservations SET status = 'cancelada' WHERE id = ?`, [id]);
}

export function resetSequencia() {
  sequencia = 0;
}
