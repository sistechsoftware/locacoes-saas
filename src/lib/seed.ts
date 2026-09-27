import "server-only";
import crypto from "node:crypto";
import { all, insert, one, run, scalar, tx } from "./db";
import { DEFAULT_CATEGORIES } from "./domain";
import { addDays, today } from "./format";
import { recalcReservation, syncOperations } from "./reservations";
import { rebuildReservationComponents } from "./stock";

function hash(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}

/** Cria usuarios, categorias e dados de demonstracao na primeira execucao. */
export async function ensureSeed() {
  if (await scalar<number>("SELECT COUNT(*) FROM users") > 0) return;

  await tx(async () => {
    const admin = await insert(
      `INSERT INTO users (name, username, password_hash, role) VALUES (?,?,?,'admin')`,
      ["Administrador", "admin", hash("admin123")],
    );
    await insert(`INSERT INTO users (name, username, password_hash, role) VALUES (?,?,?,'operador')`, [
      "Operador",
      "operador",
      hash("operador123"),
    ]);

    for (const c of DEFAULT_CATEGORIES) await run(`INSERT OR IGNORE INTO categories (name) VALUES (?)`, [c]);
    const cat = async (name: string) => await scalar<number>(`SELECT id FROM categories WHERE name = ?`, [name]);

    await insert(`INSERT INTO vehicles (name, plate, model, capacity, notes) VALUES (?,?,?,?,?)`, [
      "Carro + carretinha",
      "",
      "",
      "Ate 500 kg",
      "Veiculo principal de entregas e fretes",
    ]);

    const products: [string, string, string, number, number, number, number][] = [
      // codigo, nome, categoria, total, minimo, locacao (centavos), reposicao (centavos)
      ["MESA", "Mesa plastica", "Mesas", 50, 5, 500, 12000],
      ["CAD", "Cadeira plastica", "Cadeiras", 200, 20, 200, 6000],
      ["FRM", "Forro de mesa", "Forros", 50, 5, 300, 4000],
      ["FRC", "Forro de cadeira", "Forros", 200, 20, 150, 2500],
      ["PULA", "Pula-pula", "Brinquedos", 1, 0, 15000, 350000],
      ["PISC", "Piscina de bolinhas", "Brinquedos", 1, 0, 12000, 180000],
    ];
    const productId: Record<string, number> = {};
    for (const [code, name, category, total, min, rent, replace] of products) {
      productId[code] = await insert(
        `INSERT INTO products (code, name, category_id, kind, total_qty, min_qty, rent_price_cents, replace_cents, is_demo)
         VALUES (?,?,?,'simples',?,?,?,?,1)`,
        [code, name, await cat(category), total, min, rent, replace],
      );
    }

    // Kit de demonstracao: nao possui estoque proprio, consome mesa e cadeiras.
    const kitId = await insert(
      `INSERT INTO products (code, name, category_id, kind, total_qty, min_qty, rent_price_cents, replace_cents, description, is_demo)
       VALUES (?,?,?,'kit',0,0,?,0,?,1)`,
      [
        "KIT-MC4",
        "Kit Mesa + 4 Cadeiras",
        await cat("Outros"),
        20000,
        "Produto composto de demonstracao: 1 mesa e 4 cadeiras.",
      ],
    );
    await insert(`INSERT INTO product_components (parent_product_id, component_product_id, quantity) VALUES (?,?,?)`, [
      kitId,
      productId.MESA,
      1,
    ]);
    await insert(`INSERT INTO product_components (parent_product_id, component_product_id, quantity) VALUES (?,?,?)`, [
      kitId,
      productId.CAD,
      4,
    ]);

    // unidades individuais de exemplo para os brinquedos
    await insert(
      `INSERT INTO product_units (product_id, code, status, value_cents, condition, notes)
       VALUES (?,?,?,?,?,?)`,
      [productId.PULA, "PULA-001", "disponivel", 350000, "bom", "Unidade de demonstracao"],
    );
    await insert(
      `INSERT INTO product_units (product_id, code, status, value_cents, condition, notes)
       VALUES (?,?,?,?,?,?)`,
      [productId.PISC, "PISC-001", "disponivel", 180000, "bom", "Unidade de demonstracao"],
    );

    const customers: [string, string, string, string, string][] = [
      ["Joao Ribeiro (exemplo)", "11987650001", "Rua das Flores, 120", "Centro", "Sao Paulo"],
      ["Maria Souza (exemplo)", "11987650002", "Av. Brasil, 880", "Jardim Sul", "Sao Paulo"],
      ["Carlos Andrade (exemplo)", "11987650003", "Rua Sete, 45", "Vila Nova", "Sao Paulo"],
      ["Ana Paula Lima (exemplo)", "11987650004", "Rua do Sol, 900", "Bela Vista", "Sao Paulo"],
    ];
    const customerId: number[] = [];
    for (const [name, phone, address, district, city] of customers) {
      customerId.push(
        await insert(
          `INSERT INTO customers (name, phone, whatsapp, address, district, city, is_demo, notes)
           VALUES (?,?,?,?,?,?,1,'Cliente de demonstracao')`,
          [name, phone, phone, address, district, city],
        ),
      );
    }

    const d = today();
    const demo = [
      {
        number: "LIMA-001",
        customer: customerId[0],
        status: "confirmada",
        event_date: d,
        event_time: "12:00",
        delivery_at: `${d}T08:00`,
        pickup_at: `${addDays(d, 1)}T10:00`,
        items: [
          [productId.MESA, 10],
          [productId.CAD, 40],
          [productId.FRM, 10],
        ],
        freight: 8000,
        paid: 20000,
        deposit: 15000,
      },
      {
        number: "LIMA-002",
        customer: customerId[1],
        status: "entregue",
        event_date: d,
        event_time: "18:00",
        delivery_at: `${d}T10:30`,
        pickup_at: `${addDays(d, 1)}T14:00`,
        items: [[productId.CAD, 20]],
        freight: 5000,
        paid: 0,
        deposit: 0,
      },
      {
        number: "LIMA-003",
        customer: customerId[2],
        status: "confirmada",
        event_date: addDays(d, 3),
        event_time: "14:00",
        delivery_at: `${addDays(d, 3)}T09:00`,
        pickup_at: `${addDays(d, 4)}T11:00`,
        items: [
          [productId.MESA, 30],
          [productId.CAD, 120],
          [productId.FRM, 30],
          [productId.FRC, 120],
        ],
        freight: 12000,
        assembly: 10000,
        paid: 50000,
        deposit: 20000,
      },
      {
        number: "LIMA-004",
        customer: customerId[3],
        status: "pre_reserva",
        event_date: addDays(d, 7),
        event_time: "16:00",
        delivery_at: `${addDays(d, 7)}T13:00`,
        pickup_at: `${addDays(d, 8)}T10:00`,
        items: [
          [productId.PULA, 1],
          [productId.MESA, 6],
          [productId.CAD, 24],
        ],
        freight: 9000,
        paid: 0,
        deposit: 10000,
      },
    ];

    for (const r of demo as any[]) {
      const cust = await one<any>(`SELECT * FROM customers WHERE id = ?`, [r.customer])!;
      const id = await insert(
        `INSERT INTO reservations
          (number, customer_id, status, event_date, event_time, address, district, city,
           delivery_at, pickup_at, needs_delivery, needs_pickup, needs_assembly,
           freight_cents, assembly_cents, notes, is_demo, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,1,?)`,
        [
          r.number,
          r.customer,
          r.status,
          r.event_date,
          r.event_time,
          cust.address,
          cust.district,
          cust.city,
          r.delivery_at,
          r.pickup_at,
          r.assembly ? 1 : 0,
          r.freight ?? 0,
          r.assembly ?? 0,
          "Reserva de demonstracao",
          admin,
        ],
      );
      for (const [pid, qty] of r.items) {
        const price = await scalar<number>(`SELECT rent_price_cents FROM products WHERE id = ?`, [pid]);
        await insert(
          `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents) VALUES (?,?,?,?)`,
          [id, pid, qty, price],
        );
      }
      await rebuildReservationComponents(id);
      await recalcReservation(id);
      await syncOperations(id);
      await insert(`INSERT INTO deposits (reservation_id, amount_cents, status) VALUES (?,?,?)`, [
        id,
        r.deposit ?? 0,
        r.deposit ? "recebida" : "nao_recebida",
      ]);
      if (r.deposit) await run(`UPDATE deposits SET received_at = ?, method = 'pix' WHERE reservation_id = ?`, [d, id]);
      if (r.paid) {
        await insert(
          `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, notes, created_by)
           VALUES (?,?,?,?,?,?)`,
          [id, r.paid, "pix", d, "Sinal (demonstracao)", admin],
        );
      }
    }

    await insert(
      `INSERT INTO freights (number, customer_id, contact_name, phone, date, time, origin, destination, cargo,
                             amount_cents, status, notes, is_demo, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
      [
        "FRT-001",
        customerId[1],
        "Maria Souza (exemplo)",
        "11987650002",
        addDays(d, 2),
        "09:00",
        "Deposito Lima's",
        "Av. Brasil, 880",
        "Mudanca pequena - 12 caixas",
        18000,
        "agendado",
        "Frete de demonstracao",
        admin,
      ],
    );

    const expenses: [string, string, number][] = [
      ["Combustivel", "Abastecimento da semana", 18000],
      ["Limpeza", "Lavagem de forros", 9000],
      ["Manutencao", "Reparo em 3 cadeiras", 4500],
    ];
    for (const [category, description, amount] of expenses) {
      await insert(
        `INSERT INTO expenses (date, category, description, amount_cents, method, is_demo, created_by)
         VALUES (?,?,?,?,?,1,?)`,
        [d, category, description, amount, "dinheiro", admin],
      );
    }

    await insert(
      `INSERT INTO audit_logs (user_id, user_name, action, entity, entity_id, summary)
       VALUES (?,?,?,?,?,?)`,
      [admin, "Sistema", "seed", "sistema", null, "Base criada com dados de demonstracao"],
    );
  });
}

/** Remove todos os registros marcados como demonstracao. */
export async function purgeDemoData() {
  await tx(async () => {
    const resIds = (await all<{ id: number }>(`SELECT id FROM reservations WHERE is_demo = 1`)).map((r) => r.id);
    for (const id of resIds) {
      await run(`DELETE FROM contracts WHERE reservation_id = ?`, [id]);
      await run(`DELETE FROM payments WHERE reservation_id = ?`, [id]);
      await run(`DELETE FROM deposits WHERE reservation_id = ?`, [id]);
      await run(`DELETE FROM operations WHERE reservation_id = ?`, [id]);
      await run(`DELETE FROM reservation_item_components WHERE reservation_id = ?`, [id]);
      await run(`DELETE FROM reservation_items WHERE reservation_id = ?`, [id]);
      await run(`DELETE FROM reservations WHERE id = ?`, [id]);
    }
    await run(`DELETE FROM quotes WHERE is_demo = 1`);
    await run(`DELETE FROM freights WHERE is_demo = 1`);
    await run(`DELETE FROM expenses WHERE is_demo = 1`);
    await run(`DELETE FROM product_units WHERE product_id IN (SELECT id FROM products WHERE is_demo = 1)`);
    // remove a composicao antes dos produtos, senao a FK do componente bloqueia
    await run(
      `DELETE FROM product_components
        WHERE parent_product_id IN (SELECT id FROM products WHERE is_demo = 1)
           OR component_product_id IN (SELECT id FROM products WHERE is_demo = 1)`,
    );
    await run(`DELETE FROM products WHERE is_demo = 1 AND id NOT IN (SELECT product_id FROM reservation_items)`);
    await run(`DELETE FROM customers WHERE is_demo = 1 AND id NOT IN (SELECT customer_id FROM reservations)`);
    await run(`DELETE FROM notifications WHERE dedupe_key IS NOT NULL`);
  });
}
