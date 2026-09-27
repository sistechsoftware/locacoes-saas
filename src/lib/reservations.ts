import "server-only";
import { all, insert, one, run, scalar } from "./db";
import { stamp } from "./stock";

/* ------------------------------------------------------------------ */
/* Totais                                                              */
/* ------------------------------------------------------------------ */

/** Recalcula subtotais dos itens e o total da reserva. Fonte unica da verdade. */
export async function recalcReservation(id: number) {
  await run(
    `UPDATE reservation_items
        SET subtotal_cents = MAX(0, qty * unit_price_cents - discount_cents)
      WHERE reservation_id = ?`,
    [id],
  );
  const items = await scalar<number>(
    `SELECT COALESCE(SUM(subtotal_cents),0) FROM reservation_items WHERE reservation_id = ?`,
    [id],
  );
  await run(
    `UPDATE reservations
        SET items_cents = ?,
            total_cents = MAX(0, ? + freight_cents + assembly_cents + disassembly_cents + other_cents - discount_cents),
            updated_at  = datetime('now','localtime')
      WHERE id = ?`,
    [items, items, id],
  );
}

export async function recalcQuote(id: number) {
  await run(
    `UPDATE quote_items SET subtotal_cents = MAX(0, qty * unit_price_cents - discount_cents) WHERE quote_id = ?`,
    [id],
  );
  const items = await scalar<number>(`SELECT COALESCE(SUM(subtotal_cents),0) FROM quote_items WHERE quote_id = ?`, [id]);
  await run(
    `UPDATE quotes
        SET items_cents = ?,
            total_cents = MAX(0, ? + freight_cents + assembly_cents + disassembly_cents + other_cents - discount_cents),
            updated_at  = datetime('now','localtime')
      WHERE id = ?`,
    [items, items, id],
  );
}

/* ------------------------------------------------------------------ */
/* Operacoes vinculadas (entrega / retirada / montagem / desmontagem)  */
/* ------------------------------------------------------------------ */

const KIND_FLAG: Record<string, string> = {
  entrega: "needs_delivery",
  retirada: "needs_pickup",
  montagem: "needs_assembly",
  desmontagem: "needs_disassembly",
};

/**
 * Mantem a agenda operacional em sincronia com a reserva.
 * Cria o que falta, reagenda o que mudou e cancela o que foi desmarcado.
 * Nunca sobrescreve operacao ja concluida.
 */
export async function syncOperations(reservationId: number) {
  const r = await one<any>(`SELECT * FROM reservations WHERE id = ?`, [reservationId]);
  if (!r) return;

  const when: Record<string, string> = {
    entrega: stamp(r.delivery_at || r.event_date, "08:00"),
    montagem: stamp(r.delivery_at || r.event_date, "08:00"),
    retirada: stamp(r.pickup_at || r.event_date, "18:00"),
    desmontagem: stamp(r.pickup_at || r.event_date, "18:00"),
  };

  for (const kind of Object.keys(KIND_FLAG)) {
    const wanted = r.status !== "cancelada" && !!r[KIND_FLAG[kind]];
    const existing = await one<any>(`SELECT * FROM operations WHERE reservation_id = ? AND kind = ?`, [
      reservationId,
      kind,
    ]);

    if (wanted && !existing) {
      await insert(`INSERT INTO operations (kind, reservation_id, scheduled_at, status) VALUES (?,?,?, 'pendente')`, [
        kind,
        reservationId,
        when[kind],
      ]);
    } else if (wanted && existing) {
      if (existing.status === "concluida") continue;
      const updates: string[] = [];
      const params: any[] = [];
      if (existing.scheduled_at !== when[kind]) {
        updates.push("scheduled_at = ?");
        params.push(when[kind]);
      }
      if (existing.status === "cancelada") {
        updates.push("status = 'pendente'");
      }
      if (updates.length) {
        params.push(reservationId, kind);
        await run(
          `UPDATE operations SET ${updates.join(", ")}, updated_at = datetime('now','localtime')
            WHERE reservation_id = ? AND kind = ?`,
          params,
        );
      }
    } else if (!wanted && existing && existing.status !== "concluida" && existing.status !== "cancelada") {
      await run(
        `UPDATE operations SET status = 'cancelada', updated_at = datetime('now','localtime')
          WHERE id = ?`,
        [existing.id],
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Financeiro da reserva                                               */
/* ------------------------------------------------------------------ */

export type ReservationMoney = {
  total: number;
  paid: number;
  balance: number;
  deposit: number;
  depositStatus: string;
  depositRetained: number;
  /** Adiantamento agendado, ainda nao recebido. Nao entra em `paid` nem reduz `balance`. */
  scheduledAdvance: number;
};

export async function reservationMoney(id: number): Promise<ReservationMoney> {
  const total = await scalar<number>(`SELECT COALESCE(total_cents,0) FROM reservations WHERE id = ?`, [id]);
  const paid = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE reservation_id = ?`, [id]);
  const dep = await one<any>(`SELECT * FROM deposits WHERE reservation_id = ? ORDER BY id DESC LIMIT 1`, [id]);
  // adiantamento combinado para o futuro: e promessa, nao caixa, entao fica
  // separado do que a reserva ja recebeu de verdade
  const scheduledAdvance = await scalar<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM financial_entries
      WHERE reservation_id = ? AND category = 'Adiantamento' AND status = 'aberta'`,
    [id],
  );
  return {
    total,
    paid,
    balance: total - paid,
    deposit: dep?.amount_cents ?? 0,
    depositStatus: dep?.status ?? "nao_recebida",
    depositRetained: dep?.retained_cents ?? 0,
    scheduledAdvance,
  };
}

/* ------------------------------------------------------------------ */
/* Leitura                                                             */
/* ------------------------------------------------------------------ */

export const RESERVATION_SELECT = `
  SELECT r.*, c.name AS customer_name, c.phone AS customer_phone, c.whatsapp AS customer_whatsapp,
         c.doc AS customer_doc, c.email AS customer_email,
         c.district AS customer_district, c.city AS customer_city,
         (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.reservation_id = r.id) AS paid_cents,
         (SELECT COUNT(*) FROM reservation_items i WHERE i.reservation_id = r.id) AS item_count,
         (SELECT COALESCE(SUM(qty),0) FROM reservation_items i WHERE i.reservation_id = r.id) AS item_qty,
         (SELECT d.status FROM deposits d WHERE d.reservation_id = r.id ORDER BY d.id DESC LIMIT 1) AS deposit_status,
         (SELECT d.amount_cents FROM deposits d WHERE d.reservation_id = r.id ORDER BY d.id DESC LIMIT 1) AS deposit_cents,
         (SELECT ct.status FROM contracts ct WHERE ct.reservation_id = r.id ORDER BY ct.id DESC LIMIT 1) AS contract_status
    FROM reservations r
    JOIN customers c ON c.id = r.customer_id`;

export async function getReservation(id: number) {
  return await one<any>(`${RESERVATION_SELECT} WHERE r.id = ?`, [id]);
}

export async function getReservationByNumber(number: string) {
  return await one<any>(`${RESERVATION_SELECT} WHERE r.number = ?`, [number]);
}

export async function reservationItems(id: number) {
  return await all<any>(
    `SELECT i.*, p.name AS product_name, p.code AS product_code, p.kind AS product_kind
       FROM reservation_items i JOIN products p ON p.id = i.product_id
      WHERE i.reservation_id = ? ORDER BY i.id`,
    [id],
  );
}

export async function quoteItems(id: number) {
  return await all<any>(
    `SELECT i.*, p.name AS product_name, p.code AS product_code, p.kind AS product_kind
       FROM quote_items i JOIN products p ON p.id = i.product_id
      WHERE i.quote_id = ? ORDER BY i.id`,
    [id],
  );
}

export async function reservationOperations(id: number) {
  return await all<any>(
    `SELECT o.*, v.name AS vehicle_name FROM operations o
       LEFT JOIN vehicles v ON v.id = o.vehicle_id
      WHERE o.reservation_id = ? ORDER BY o.scheduled_at`,
    [id],
  );
}

/**
 * Resumo "3x Kit Mesa, 2x Cadeira" a partir dos itens JA carregados.
 *
 * Antes reconsultava o banco com os itens que a tela de detalhe ja tinha em
 * maos — uma consulta desperdicada por abertura. Quem tem a lista em memoria
 * passa direto; quem so tem o id usa reservationItems antes.
 */
export function itemsSummary(items: { qty: number; product_name: string }[]): string {
  return items.map((i) => `${i.qty}x ${i.product_name}`).join(", ");
}

/* ------------------------------------------------------------------ */
/* Itens comerciais para as listagens                                  */
/* ------------------------------------------------------------------ */

export type ComponenteResumo = { product_id: number; name: string; qty: number };
export type ItemResumo = {
  item_id: number;
  product_id: number;
  name: string;
  qty: number;
  kind: string;
  /** So para kit: o que sai do galpao. Vem do que foi gravado na reserva. */
  componentes: ComponenteResumo[];
};

/**
 * Itens de varias reservas de uma vez.
 *
 * A listagem mostra o produto comercial que o cliente contratou ("5x Kit Mesa
 * + 4 Cadeiras"), nao a soma de pecas. A composicao vem de
 * reservation_item_components, que e o retrato do kit no dia da reserva: se a
 * receita do kit mudar depois, a reserva antiga continua exibindo o que foi
 * realmente separado. Duas consultas para a pagina inteira, nunca uma por
 * reserva.
 */
export async function itemsForReservations(ids: number[]): Promise<Map<number, ItemResumo[]>> {
  const porReserva = new Map<number, ItemResumo[]>();
  if (ids.length === 0) return porReserva;
  const marcas = ids.map(() => "?").join(",");

  const [itens, componentes] = await Promise.all([
    all<any>(
      `SELECT i.id AS item_id, i.reservation_id, i.product_id, i.qty,
              p.name AS product_name, p.kind AS product_kind
         FROM reservation_items i JOIN products p ON p.id = i.product_id
        WHERE i.reservation_id IN (${marcas})
        ORDER BY i.reservation_id, i.id`,
      ids,
    ),
    all<any>(
      `SELECT c.reservation_item_id, c.product_id, c.qty, p.name AS product_name
         FROM reservation_item_components c JOIN products p ON p.id = c.product_id
        WHERE c.reservation_id IN (${marcas})
        ORDER BY c.id`,
      ids,
    ),
  ]);

  const porItem = new Map<number, ComponenteResumo[]>();
  for (const c of componentes) {
    const lista = porItem.get(c.reservation_item_id) ?? [];
    lista.push({ product_id: c.product_id, name: c.product_name, qty: c.qty });
    porItem.set(c.reservation_item_id, lista);
  }

  for (const i of itens) {
    const brutos = porItem.get(i.item_id) ?? [];
    // produto simples tem uma linha 1:1 apontando para ele mesmo; isso nao e
    // composicao, e repetir "2x Mesa - composicao: 2x Mesa" so poluiria a tela
    const componentesReais =
      brutos.length === 1 && brutos[0].product_id === i.product_id ? [] : brutos;
    const lista = porReserva.get(i.reservation_id) ?? [];
    lista.push({
      item_id: i.item_id,
      product_id: i.product_id,
      name: i.product_name,
      qty: i.qty,
      kind: i.product_kind,
      componentes: componentesReais,
    });
    porReserva.set(i.reservation_id, lista);
  }
  return porReserva;
}

/** Total de pecas fisicas que saem do galpao, util para carga e conferencia. */
export function pecasFisicas(itens: ItemResumo[]): number {
  return itens.reduce(
    (soma, i) => soma + (i.componentes.length > 0 ? i.componentes.reduce((s, c) => s + c.qty, 0) : i.qty),
    0,
  );
}
