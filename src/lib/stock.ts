import "server-only";
import { promocoesAtivasPorProduto } from "./promocoes-db";
import { all, one, run, batch } from "./db";
import { addMinutes, normalizeStamp, timeWindow } from "./availability-time";
import { stockOptions, type StockOptions } from "./availability-settings";
import { commitStockBatch } from "./stock-write";
import { HOLDING_STATUSES } from "./domain";
import {
  buildSpecMap,
  computeConflicts,
  conflictText,
  expandDemand,
  explodeLine,
  isKit,
  kitCapacity,
  type Line,
  type LineConflict,
  type SpecMap,
} from "./kits";

/**
 * Motor de disponibilidade.
 *
 * Duas regras se combinam aqui:
 *
 * 1. TEMPO - o estoque nao e um contador simples: cada reserva ocupa o
 *    equipamento apenas durante a janela [entrega, retirada). Duas reservas em
 *    datas diferentes usam o mesmo equipamento sem conflito. Por isso a
 *    disponibilidade e o PICO de uso simultaneo dentro da janela consultada.
 *
 * 2. COMPOSICAO - kits nao tem estoque proprio. Toda linha de reserva e
 *    expandida para os produtos fisicos que consome (tabela
 *    reservation_item_components) e o calculo acontece sempre sobre eles.
 */

const HOLD = HOLDING_STATUSES.map((s) => `'${s}'`).join(",");

export type Hold = {
  reservation_id: number;
  number: string;
  customer: string;
  status: string;
  qty: number;
  hold_start: string;
  hold_end: string;
  /** Produto comercial que originou a ocupacao (kit ou o proprio produto). */
  via_product?: string | null;
  /** Id do produto comercial (linha da reserva) que originou a ocupacao; nulo
   *  quando o item foi removido. Leitura apenas, nunca usado no calculo de
   *  estoque — evita duplicar o uso comercial do kit ao agregar por item. */
  via_product_id?: number | null;
  /** Id da linha comercial (reservation_items) que originou a ocupacao. */
  via_item_id?: number | null;
  /** Quantidade comercial da linha (quantos kits a linha contratou). */
  via_qty?: number | null;
};

export type Availability = {
  product_id: number;
  code: string;
  name: string;
  category: string | null;
  kind: "simples" | "kit";
  total: number;
  maintenance: number;
  effective: number;
  reserved: number;
  available: number;
  min_qty: number;
  low: boolean;
  /** Preenchido so para kit: o que ele consome por unidade. */
  components?: { product_id: number; name: string; quantity: number }[];
};

/** Normaliza para o formato comparavel YYYY-MM-DDTHH:MM. */
export function stamp(value: string | null | undefined, fallbackTime = "00:00"): string {
  return normalizeStamp(value, fallbackTime);
}

/** Janela de ocupacao de uma reserva a partir dos seus campos. */
export function holdWindow(r: {
  delivery_at?: string | null;
  pickup_at?: string | null;
  event_date: string;
}): { from: string; to: string } {
  return {
    from: stamp(r.delivery_at || r.event_date, "00:00"),
    to: r.pickup_at ? stamp(r.pickup_at, "23:59") : addMinutes(stamp(r.event_date), 1440),
  };
}

/* ------------------------------------------------------------------ */
/* Fichas de produto (composicao)                                      */
/* ------------------------------------------------------------------ */

/** Carrega a ficha de composicao de todos os produtos. */
export async function loadSpecs(): Promise<SpecMap> {
  const [products, components] = await Promise.all([
    all<{ id: number; name: string; kind: string }>(`SELECT id, name, kind FROM products`),
    all<{ parent_product_id: number; component_product_id: number; quantity: number }>(
      `SELECT parent_product_id, component_product_id, quantity FROM product_components`,
    ),
  ]);
  return buildSpecMap(products, components);
}

/**
 * Catalogo vendavel: produtos simples e kits, com a composicao ja resumida.
 * Usado pelos formularios de reserva e orcamento.
 */
export async function sellableProducts() {
  const [rows, comps, promocoes] = await Promise.all([
    all<any>(
      `SELECT p.id, p.code, p.name, p.kind, p.rent_price_cents, p.total_qty, c.name AS category
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.active = 1
        ORDER BY c.name, p.name`,
    ),
    all<any>(
      `SELECT pc.parent_product_id, pc.quantity, p.name
         FROM product_components pc JOIN products p ON p.id = pc.component_product_id
        ORDER BY p.name`,
    ),
    // a promocao viaja junto com o produto para o formulario decidir o preco
    // sem uma consulta por linha; a vigencia por data e avaliada la, contra a
    // data do evento que o operador escolheu
    promocoesAtivasPorProduto(),
  ]);
  const byParent = new Map<number, string[]>();
  for (const c of comps) {
    const list = byParent.get(c.parent_product_id) ?? [];
    list.push(`${c.quantity} ${c.name}`);
    byParent.set(c.parent_product_id, list);
  }
  return rows.map((r) => ({
    ...r,
    composition: r.kind === "kit" ? (byParent.get(r.id) ?? []).join(" + ") || null : null,
    promocao: promocoes.get(r.id) ?? null,
  }));
}

/** Componentes de um kit, com nome e codigo, para exibicao. */
export async function componentsOf(productId: number) {
  return await all<any>(
    `SELECT pc.*, p.name AS component_name, p.code AS component_code, p.total_qty, p.maintenance_qty
       FROM product_components pc
       JOIN products p ON p.id = pc.component_product_id
      WHERE pc.parent_product_id = ?
      ORDER BY p.name`,
    [productId],
  );
}

/** Kits que utilizam o produto informado como componente. */
export async function kitsUsing(productId: number) {
  return await all<any>(
    `SELECT pc.quantity, p.id, p.name, p.code
       FROM product_components pc
       JOIN products p ON p.id = pc.parent_product_id
      WHERE pc.component_product_id = ?
      ORDER BY p.name`,
    [productId],
  );
}

/* ------------------------------------------------------------------ */
/* Ocupacao fisica                                                     */
/* ------------------------------------------------------------------ */

/**
 * Reservas que ocupam fisicamente um produto dentro da janela.
 *
 * Le a expansao (reservation_item_components), portanto ja considera tanto os
 * itens individuais quanto os componentes vindos de kits.
 */
export async function holdsForProduct(
  productId: number,
  from: string,
  to: string,
  excludeReservationId?: number | null,
  maxReservationId?: number | null,
  options: StockOptions = {},
): Promise<Hold[]> {
  return loadHoldsInner(from, to, options, excludeReservationId, productId, maxReservationId);
}

/** Single source of physical commitments. Normalize before comparing: SQL text
 * comparisons cannot safely compare local clocks, spaces and explicit offsets.
 * Only stock-holding statuses are loaded; historic/completed rows are excluded.
 */
async function loadHoldsInner(from: string, to: string, options: StockOptions = {}, excludeId?: number | null, productId?: number | null, maxId?: number | null) {
  const w = timeWindow(from, to, true);
  const config = await stockOptions(options);
  const rows = await all<Hold & { product_id: number; event_date: string; delivery_at: string; pickup_at: string; stock_override: number }>(
    `SELECT ric.product_id, r.id AS reservation_id, r.number, c.name AS customer, r.status,
            ric.qty, prod.name AS via_product, ri.product_id AS via_product_id, ri.id AS via_item_id, ri.qty AS via_qty, r.event_date, r.delivery_at, r.pickup_at, r.stock_override
       FROM reservation_item_components ric
       JOIN reservations r ON r.id = ric.reservation_id
       JOIN customers c ON c.id = r.customer_id
       LEFT JOIN reservation_items ri ON ri.id = ric.reservation_item_id
       LEFT JOIN products prod ON prod.id = ri.product_id
      WHERE r.status IN (${HOLD})
        AND (? IS NULL OR ric.product_id = ?)
        AND (? IS NULL OR r.id <> ?)
        AND (? IS NULL OR r.id <= ?)
      ORDER BY r.id`,
    [
      productId ?? null, productId ?? -1,
      excludeId ?? null, excludeId ?? -1,
      maxId ?? null, maxId ?? -1,
    ],
  );
  return rows.map((r) => {
    const h = holdWindow(r);
    timeWindow(h.from, h.to);
    return { ...r, qty: Number(r.qty), hold_start: h.from, hold_end: addMinutes(h.to, config.preparationMinutes) };
  }).filter((h) => h.hold_end > w.from && (w.from === w.to ? h.hold_start <= w.from : h.hold_start < w.to));
}

/** Ocupacoes de uma janela, para leituras somente de consulta (timeline). */
export async function loadHolds(
  from: string,
  to: string,
  options: StockOptions = {},
  excludeId?: number | null,
  productId?: number | null,
  maxId?: number | null,
) {
  return loadHoldsInner(from, to, options, excludeId, productId, maxId);
}

/** Pico de uso simultaneo dentro da janela (varredura de intervalos). */
export function peakUsage(holds: Hold[], from: string, to: string): number {
  ({ from, to } = timeWindow(from, to, true));
  if (from === to) return holds.reduce((sum, h) => sum + (h.hold_start <= from && h.hold_end > from ? h.qty : 0), 0);
  const events: { t: string; d: number }[] = [];
  for (const h of holds) {
    const s = h.hold_start < from ? from : h.hold_start;
    const e = h.hold_end > to ? to : h.hold_end;
    if (e <= s) continue;
    events.push({ t: s, d: h.qty });
    events.push({ t: e, d: -h.qty });
  }
  events.sort((a, b) => (a.t === b.t ? a.d - b.d : a.t < b.t ? -1 : 1));
  let cur = 0;
  let peak = 0;
  for (const ev of events) {
    cur += ev.d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

export type Trecho = {
  /** Inicio do trecho, no formato YYYY-MM-DDTHH:MM. */
  from: string;
  to: string;
  reserved: number;
  available: number;
};

/**
 * Linha do tempo da disponibilidade dentro da janela.
 *
 * peakUsage responde "qual o pior momento da janela", que e a pergunta certa
 * para saber se uma reserva cabe. Mas responder so isso esconde a informacao
 * util do dia a dia: consultar o dia inteiro devolve zero quando ha uma
 * devolucao ao meio-dia, mesmo havendo equipamento livre a tarde.
 *
 * Esta funcao quebra a janela nos instantes em que a ocupacao muda e diz
 * quanto fica livre em cada trecho. Usa exatamente as mesmas ocupacoes de
 * peakUsage, entao nao introduz uma segunda regra de estoque.
 */
export function availabilityTimeline(
  holds: Hold[],
  effective: number,
  from: string,
  to: string,
): Trecho[] {
  ({ from, to } = timeWindow(from, to, true));
  if (from === to) {
    const reserved = peakUsage(holds, from, to);
    return [{ from, to, reserved, available: effective - reserved }];
  }
  const marcos = new Set<string>([from, to]);
  for (const h of holds) {
    const s = h.hold_start < from ? from : h.hold_start;
    const e = h.hold_end > to ? to : h.hold_end;
    if (e <= s) continue;
    marcos.add(s);
    marcos.add(e);
  }
  const pontos = [...marcos].filter((t) => t >= from && t <= to).sort();

  const trechos: Trecho[] = [];
  for (let i = 0; i < pontos.length - 1; i++) {
    const ini = pontos[i];
    const fim = pontos[i + 1];
    if (fim <= ini) continue;
    // ocupacao vigente no meio do trecho: entre dois marcos ela nao muda
    const reserved = holds.reduce((soma, h) => {
      const s = h.hold_start < from ? from : h.hold_start;
      const e = h.hold_end > to ? to : h.hold_end;
      return s <= ini && e >= fim ? soma + h.qty : soma;
    }, 0);
    trechos.push({ from: ini, to: fim, reserved, available: effective - reserved });
  }

  // junta trechos vizinhos com a mesma disponibilidade, para nao poluir a tela
  const juntos: Trecho[] = [];
  for (const t of trechos) {
    const ultimo = juntos[juntos.length - 1];
    if (ultimo && ultimo.reserved === t.reserved) ultimo.to = t.to;
    else juntos.push({ ...t });
  }
  return juntos;
}

/**
 * Primeiro momento da janela em que passa a haver `qty` unidades livres.
 * Devolve null quando nao ha esse momento dentro da janela.
 */
export function disponivelAPartirDe(trechos: Trecho[], qty: number): string | null {
  const t = trechos.find((x) => x.available >= qty);
  return t ? t.from : null;
}

/* ------------------------------------------------------------------ */
/* Disponibilidade                                                     */
/* ------------------------------------------------------------------ */

function availabilityRow(p: any, reserved: number): Availability {
  const effective = Math.max(0, p.total_qty - p.maintenance_qty);
  return {
    product_id: p.id,
    code: p.code,
    name: p.name,
    category: p.category,
    kind: p.kind === "kit" ? "kit" : "simples",
    total: p.total_qty,
    maintenance: p.maintenance_qty,
    effective,
    reserved,
    available: effective - reserved,
    min_qty: p.min_qty,
    low: effective - reserved < p.min_qty,
  };
}

/**
 * Disponibilidade de um produto na janela.
 * Para kits, e derivada dos componentes (menor razao, arredondada para baixo).
 */
export async function availabilityFor(
  productId: number,
  from: string,
  to: string,
  excludeReservationId?: number | null,
  options: StockOptions = {},
): Promise<Availability> {
  ({ from, to } = timeWindow(from, to, true));
  const p = await one<any>(
    `SELECT p.id, p.code, p.name, p.kind, p.total_qty, p.maintenance_qty, p.min_qty, c.name AS category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
    [productId],
  );
  if (!p) throw new Error("Produto não encontrado: " + productId);

  if (p.kind === "kit") {
    const specs = await loadSpecs();
    const spec = specs.get(productId);
    const physical = await physicalAvailability(from, to, excludeReservationId, options);
    const capacity = spec ? kitCapacity(spec, physical) : 0;
    return {
      product_id: p.id,
      code: p.code,
      name: p.name,
      category: p.category,
      kind: "kit",
      total: 0,
      maintenance: 0,
      effective: 0,
      reserved: 0,
      available: capacity,
      min_qty: p.min_qty,
      low: capacity < p.min_qty,
    };
  }

  const holds = await holdsForProduct(productId, from, to, excludeReservationId, null, options);
  return availabilityRow(p, peakUsage(holds, from, to));
}

/**
 * Disponibilidade do produto em N janelas diarias consecutivas (serie).
 *
 * A tela de detalhe do estoque mostrava 14 dias chamando availabilityFor
 * quinze vezes: cada chamada re-consultava produtos, ocupacoes e composicao,
 * dando dezenas de idas ao D1 para desenhar um calendario. Aqui as ocupacoes
 * sao lidas UMA vez cobrindo a janela inteira e o pico de cada dia e apurado
 * em memoria com o mesmo peakUsage — regra identica, custo de leitura unico.
 *
 * A janela do dia i e [from + i dias, to + i dias], exatamente o deslocamento
 * que a tela fazia antes.
 */
export async function availabilityForDays(
  productId: number,
  from: string,
  to: string,
  days: number,
  options: StockOptions = {},
): Promise<Availability[]> {
  ({ from, to } = timeWindow(from, to, true));
  const n = Math.max(1, Math.floor(days));
  const config = await stockOptions(options);
  const fimTotal = addMinutes(to, (n - 1) * 1440);

  const p = await one<any>(
    `SELECT p.id, p.code, p.name, p.kind, p.total_qty, p.maintenance_qty, p.min_qty, c.name AS category
       FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`,
    [productId],
  );
  if (!p) throw new Error("Produto não encontrado: " + productId);

  if (p.kind === "kit") {
    const spec = (await loadSpecs()).get(productId);
    // ocupacoes de TODOS os produtos fisicos da janela inteira: a capacidade
    // do kit em cada dia e derivada dos componentes, como em availabilityFor
    const [products, holds] = await Promise.all([
      all<any>(
        `SELECT p.id, p.code, p.name, p.kind, p.total_qty, p.maintenance_qty, p.min_qty, c.name AS category
           FROM products p LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.active = 1 AND p.kind <> 'kit'`,
      ),
      loadHoldsInner(from, fimTotal, config),
    ]);
    const efetivo = new Map<number, number>(products.map((x) => [x.id, Math.max(0, x.total_qty - x.maintenance_qty)]));
    const porProduto = new Map<number, Hold[]>();
    for (const h of holds) {
      const list = porProduto.get(h.product_id) ?? [];
      list.push(h);
      porProduto.set(h.product_id, list);
    }
    return Array.from({ length: n }, (_, i) => {
      const f = addMinutes(from, i * 1440);
      const t = addMinutes(to, i * 1440);
      const disponivel = new Map<number, number>();
      for (const x of products) {
        disponivel.set(x.id, (efetivo.get(x.id) ?? 0) - peakUsage(porProduto.get(x.id) ?? [], f, t));
      }
      const capacity = spec ? kitCapacity(spec, disponivel) : 0;
      return {
        product_id: p.id,
        code: p.code,
        name: p.name,
        category: p.category,
        kind: "kit" as const,
        total: 0,
        maintenance: 0,
        effective: 0,
        reserved: 0,
        available: capacity,
        min_qty: p.min_qty,
        low: capacity < p.min_qty,
      };
    });
  }

  const holds = await loadHoldsInner(from, fimTotal, config, null, productId);
  return Array.from({ length: n }, (_, i) => {
    const f = addMinutes(from, i * 1440);
    const t = addMinutes(to, i * 1440);
    return availabilityRow(p, peakUsage(holds, f, t));
  });
}

/**
 * Disponibilidade de todos os produtos FISICOS (simples) ativos na janela.
 * Kits ficam de fora para nao duplicar contagem em somatorios.
 */
export async function availabilityAll(
  from: string,
  to: string,
  excludeReservationId?: number | null,
  options: StockOptions = {},
): Promise<Availability[]> {
  ({ from, to } = timeWindow(from, to, true));
  const [products, rows] = await Promise.all([
    all<any>(
      `SELECT p.id, p.code, p.name, p.kind, p.total_qty, p.maintenance_qty, p.min_qty, c.name AS category
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.active = 1 AND p.kind <> 'kit'
        ORDER BY c.name, p.name`,
    ),
    loadHoldsInner(from, to, options, excludeReservationId),
  ]);
  const byProduct = new Map<number, Hold[]>();
  for (const r of rows) {
    const list = byProduct.get(r.product_id) ?? [];
    list.push(r);
    byProduct.set(r.product_id, list);
  }
  return products.map((p) => availabilityRow(p, peakUsage(byProduct.get(p.id) ?? [], from, to)));
}

/** Mapa produto fisico -> unidades livres na janela. */
export async function physicalAvailability(
  from: string,
  to: string,
  excludeReservationId?: number | null,
  options: StockOptions = {},
): Promise<Map<number, number>> {
  const rows = await availabilityAll(from, to, excludeReservationId, options);
  return new Map(rows.map((r) => [r.product_id, r.available]));
}

/**
 * Produtos fisicos e kits juntos, para telas de consulta.
 * O kit aparece com a quantidade que da para montar, nunca como estoque fisico.
 */
/**
 * Disponibilidade dos produtos compostos a partir de uma disponibilidade
 * fisica ja calculada.
 *
 * Recebe o resultado de availabilityAll em vez de consultar de novo, para o
 * painel nao pagar duas vezes pela mesma leitura. A composicao vem do cadastro
 * (product_components), entao qualquer kit novo passa a aparecer sozinho, sem
 * precisar de codigo.
 */
export async function kitsFromPhysical(physical: Availability[]): Promise<Availability[]> {
  const disponivel = new Map(physical.map((r) => [r.product_id, r.available]));
  const [kits, specs] = await Promise.all([
    all<any>(
      `SELECT p.id, p.code, p.name, p.kind, p.min_qty, c.name AS category
         FROM products p LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.active = 1 AND p.kind = 'kit'
        ORDER BY c.name, p.name`,
    ),
    loadSpecs(),
  ]);

  const nomes = new Map(physical.map((r) => [r.product_id, r.name]));
  return kits.map((p) => {
    const spec = specs.get(p.id);
    const capacity = spec ? kitCapacity(spec, disponivel) : 0;
    return {
      product_id: p.id,
      code: p.code,
      name: p.name,
      category: p.category,
      kind: "kit" as const,
      total: 0,
      maintenance: 0,
      effective: 0,
      reserved: 0,
      available: capacity,
      min_qty: p.min_qty,
      low: capacity < p.min_qty,
      components: (spec?.components ?? []).map((c) => ({
        product_id: c.product_id,
        name: nomes.get(c.product_id) ?? `#${c.product_id}`,
        quantity: c.quantity,
      })),
    };
  });
}

export async function availabilityAllWithKits(
  from: string,
  to: string,
  excludeReservationId?: number | null,
  options: StockOptions = {},
): Promise<Availability[]> {
  const physical = await availabilityAll(from, to, excludeReservationId, options);
  return [...physical, ...(await kitsFromPhysical(physical))];
}

/* ------------------------------------------------------------------ */
/* Conflitos                                                           */
/* ------------------------------------------------------------------ */

export type Conflict = LineConflict & { holds: Hold[] };

/**
 * Verifica se as linhas pedidas cabem no estoque durante a janela.
 *
 * As linhas sao COMERCIAIS (podem misturar kits e produtos individuais). A
 * expansao para produtos fisicos acontece aqui dentro, uma unica vez.
 */
export async function checkConflicts(
  items: Line[],
  from: string,
  to: string,
  excludeReservationId?: number | null,
  options: StockOptions = {},
): Promise<Conflict[]> {
  ({ from, to } = timeWindow(from, to));
  const config = await stockOptions(options);
  // A proposed rental also needs preparation before the NEXT commitment.
  // Generic availability queries never extend their requested interval.
  to = addMinutes(to, config.preparationMinutes);
  const lines = items.filter((i) => i.product_id && Number(i.qty) > 0);
  if (!lines.length) return [];

  const specs = await loadSpecs();
  const available = await physicalAvailability(from, to, excludeReservationId, config);
  const conflicts = computeConflicts(lines, specs, available);

  const out: Conflict[] = [];
  for (const c of conflicts) {
    const spec = specs.get(c.product_id);
    let holds: Hold[] = [];
    if (isKit(spec)) {
      for (const comp of c.components) {
        holds = holds.concat(await holdsForProduct(comp.product_id, from, to, excludeReservationId, null, config));
      }
    } else {
      holds = await holdsForProduct(c.product_id, from, to, excludeReservationId, null, config);
    }
    out.push({ ...c, holds });
  }
  return out;
}

/** Revalidate an existing reservation against its SAVED physical composition. */
export async function checkReservationConflicts(reservationId: number, options: StockOptions = {}): Promise<Conflict[]> {
  const r = await one<any>(`SELECT * FROM reservations WHERE id = ?`, [reservationId]);
  if (!r) return [];
  const w = holdWindow(r);
  const config = await stockOptions(options);
  const to = addMinutes(w.to, config.preparationMinutes);

  /*
   * Uma leitura so, em lote.
   *
   * Antes esta funcao chamava availabilityFor para CADA produto que a reserva
   * consome (N+1): cada chamada refazia a leitura de produtos, ocupacoes e
   * fichas de composicao, e a tela de detalhe pagava isso a cada abertura.
   * O padrao correto e o mesmo de availabilityAll: ler a disponibilidade de
   * TODOS os produtos fisicos da janela uma unica vez e procurar o produto de
   * cada consumo no mapa. Mesma regra de calculo, sem nenhuma segunda fonte.
   */
  const [usage, disponibilidade] = await Promise.all([
    reservationPhysicalUsage(reservationId),
    availabilityAll(w.from, to, reservationId, config),
  ]);
  const porProduto = new Map(disponibilidade.map((a) => [a.product_id, a]));

  const out: Conflict[] = [];
  for (const u of usage) {
    const a = porProduto.get(u.product_id);
    // produto consumido que sumiu do cadastro ativo nao bloqueia a tela
    if (!a) continue;
    if (u.qty > a.available) {
      out.push({
        product_id: u.product_id,
        product: u.product_name,
        kind: "simples",
        requested: u.qty,
        available: a.available,
        missing: u.qty - a.available,
        components: [],
        holds: await holdsForProduct(u.product_id, w.from, to, reservationId, null, config),
      });
    }
  }
  return out;
}

/** Mensagem unica para uma lista de conflitos. */
export function conflictsMessage(conflicts: LineConflict[]): string {
  return "ESTOQUE INSUFICIENTE. " + conflicts.map(conflictText).join(" ");
}

/* ------------------------------------------------------------------ */
/* Expansao / gravacao do consumo fisico                               */
/* ------------------------------------------------------------------ */

/**
 * Regrava a fotografia do consumo fisico de uma reserva.
 *
 * Chamada sempre que os itens da reserva mudam. Como a expansao e refeita a
 * partir da composicao vigente NAQUELE momento, uma alteracao posterior no kit
 * nao mexe em reservas ja gravadas.
 */
export async function rebuildReservationComponents(reservationId: number, version?: number) {
  const items = await all<{ id: number; product_id: number; qty: number }>(
    `SELECT id, product_id, qty FROM reservation_items WHERE reservation_id = ?`,
    [reservationId],
  );
  const specs = await loadSpecs();

  const statements: { sql: string; params: any[] }[] = [{ sql: `DELETE FROM reservation_item_components WHERE reservation_id = ?`, params: [reservationId] }];

  for (const item of items) {
    const spec = specs.get(item.product_id);
    const parts = explodeLine({ product_id: item.product_id, qty: item.qty }, specs);
    for (const part of parts) {
      const perUnit = isKit(spec)
        ? (spec!.components.find((c) => c.product_id === part.product_id)?.quantity ?? 1)
        : 1;
      statements.push({ sql: `INSERT INTO reservation_item_components
           (reservation_id, reservation_item_id, product_id, qty_per_unit, qty)
         VALUES (?,?,?,?,?)`, params: [reservationId, item.id, part.product_id, perUnit, part.qty] });
    }
  }
  if (version !== undefined) await commitStockBatch(version, statements);
  else await batch(statements);
}

/**
 * Compara a expansao gravada com a que a composicao atual dos kits produziria.
 *
 * A fotografia e proposital: uma reserva ja fechada nao pode mudar sozinha
 * porque alguem editou o kit depois. Mas quando a composicao foi corrigida
 * (por exemplo, o kit foi cadastrado faltando um componente), a reserva antiga
 * fica com um consumo que nao corresponde mais a realidade. Esta funcao aponta
 * essa divergencia para que a tela possa oferecer a atualizacao.
 */
export async function compositionDrift(reservationId: number): Promise<
  { product: string; gravado: number; atual: number }[]
> {
  const items = await all<{ id: number; product_id: number; qty: number }>(
    `SELECT id, product_id, qty FROM reservation_items WHERE reservation_id = ?`,
    [reservationId],
  );
  if (!items.length) return [];

  const specs = await loadSpecs();
  const esperado = new Map<number, number>();
  for (const item of items) {
    for (const parte of explodeLine({ product_id: item.product_id, qty: item.qty }, specs)) {
      esperado.set(parte.product_id, (esperado.get(parte.product_id) ?? 0) + parte.qty);
    }
  }

  const gravadoRows = await all<{ product_id: number; qty: number }>(
    `SELECT product_id, SUM(qty) AS qty FROM reservation_item_components
      WHERE reservation_id = ? GROUP BY product_id`,
    [reservationId],
  );
  const gravado = new Map(gravadoRows.map((r) => [r.product_id, Number(r.qty)]));

  const nomes = new Map([...specs.values()].map((s) => [s.id, s.name]));
  const diffs: { product: string; gravado: number; atual: number }[] = [];
  for (const productId of new Set([...esperado.keys(), ...gravado.keys()])) {
    const a = gravado.get(productId) ?? 0;
    const b = esperado.get(productId) ?? 0;
    if (a !== b) {
      diffs.push({ product: nomes.get(productId) ?? `Produto ${productId}`, gravado: a, atual: b });
    }
  }
  return diffs;
}

/** Consumo fisico gravado de uma reserva, agrupado por produto. */
export async function reservationPhysicalUsage(reservationId: number) {
  return await all<any>(
    `SELECT ric.product_id, p.name AS product_name, p.code AS product_code, SUM(ric.qty) AS qty
       FROM reservation_item_components ric
       JOIN products p ON p.id = ric.product_id
      WHERE ric.reservation_id = ?
      GROUP BY ric.product_id
      ORDER BY p.name`,
    [reservationId],
  );
}

/* ------------------------------------------------------------------ */
/* Concorrencia                                                        */
/* ------------------------------------------------------------------ */

export type Overbooking = {
  product_id: number;
  product: string;
  effective: number;
  used: number;
  excess: number;
};

export type ConflictScanRow = {
  reservation_id: number;
  number: string;
  customer: string;
  faltas: { product: string; missing: number }[];
};

/**
 * Varredura global de conflitos, em consultas de tamanho fixo.
 *
 * A versao ingenua percorria cada reserva chamando checkConflicts, o que dava
 * centenas de consultas por carregamento de pagina. Aqui todas as ocupacoes
 * sao lidas de uma vez e o excesso e apurado em memoria, por produto, com uma
 * varredura da linha do tempo: sempre que o uso simultaneo passa do estoque,
 * as reservas ativas naquele instante entram no resultado.
 */
export async function scanConflicts(fromDate: string, options: StockOptions = {}, until = "9999-12-31T23:59"): Promise<ConflictScanRow[]> {
  const from = stamp(fromDate);
  const [holds, produtos] = await Promise.all([
    loadHoldsInner(from, until, options),
    all<any>(`SELECT id, name, total_qty, maintenance_qty FROM products WHERE kind <> 'kit'`),
  ]);
  if (!holds.length) return [];

  const estoque = new Map(produtos.map((p) => [p.id, { name: p.name, efetivo: Math.max(0, p.total_qty - p.maintenance_qty) }]));

  const porProduto = new Map<number, any[]>();
  for (const h of holds) {
    const lista = porProduto.get(h.product_id) ?? [];
    lista.push(h);
    porProduto.set(h.product_id, lista);
  }

  const faltasPorReserva = new Map<number, { number: string; customer: string; faltas: Map<string, number> }>();

  for (const [productId, lista] of porProduto) {
    const info = estoque.get(productId);
    if (!info) continue;

    const eventos: { t: string; delta: number; hold: any }[] = [];
    for (const h of lista) {
      eventos.push({ t: h.hold_start < from ? from : h.hold_start, delta: h.qty, hold: h });
      const end = until === from ? addMinutes(from, 1) : until;
      eventos.push({ t: h.hold_end > end ? end : h.hold_end, delta: -h.qty, hold: h });
    }
    eventos.sort((a, b) => (a.t === b.t ? a.delta - b.delta : a.t < b.t ? -1 : 1));

    const ativos = new Map<any, number>();
    let usado = 0;
    for (const ev of eventos) {
      if (ev.delta > 0) {
        ativos.set(ev.hold, (ativos.get(ev.hold) ?? 0) + ev.delta);
        usado += ev.delta;
      } else {
        usado += ev.delta;
        ativos.delete(ev.hold);
      }
      const excesso = usado - info.efetivo;
      if (excesso <= 0) continue;
      for (const h of ativos.keys()) {
        // An authorized excess still consumes stock for every OTHER rental.
        if (h.stock_override) continue;
        const atual = faltasPorReserva.get(h.reservation_id) ?? {
          number: h.number,
          customer: h.customer,
          faltas: new Map<string, number>(),
        };
        atual.faltas.set(info.name, Math.max(atual.faltas.get(info.name) ?? 0, excesso));
        faltasPorReserva.set(h.reservation_id, atual);
      }
    }
  }

  return [...faltasPorReserva.entries()].map(([reservation_id, v]) => ({
    reservation_id,
    number: v.number,
    customer: v.customer,
    faltas: [...v.faltas.entries()].map(([product, missing]) => ({ product, missing })),
  }));
}

/**
 * Verifica, DEPOIS da escrita, se esta reserva estourou o estoque fisico.
 *
 * O D1 nao tem transacao interativa para segurar linha ate o commit, entao a
 * protecao contra duas reservas simultaneas do mesmo ultimo item e feita por
 * verificacao otimista: cada reserva confere se ela cabe considerando apenas
 * as reservas MAIS ANTIGAS que ela (id <= o proprio id). Se duas gravarem ao
 * mesmo tempo, a mais nova enxerga a mais antiga e desiste; a mais antiga nao
 * enxerga a mais nova e permanece. Esta e apenas uma ferramenta de diagnostico
 * legado: a protecao de gravacao agora usa revisao e batch atomico (stock-write).
 */
export async function findOverbookings(reservationId: number, options: StockOptions = {}): Promise<Overbooking[]> {
  const r = await one<any>(
    `SELECT id, event_date, delivery_at, pickup_at, status FROM reservations WHERE id = ?`,
    [reservationId],
  );
  if (!r) return [];
  if (!(HOLDING_STATUSES as readonly string[]).includes(r.status)) return [];

  const config = await stockOptions(options);
  const window = holdWindow(r);
  const from = window.from, to = addMinutes(window.to, config.preparationMinutes);
  const usage = await all<{ product_id: number }>(
    `SELECT DISTINCT product_id FROM reservation_item_components WHERE reservation_id = ?`,
    [reservationId],
  );

  const out: Overbooking[] = [];
  for (const u of usage) {
    const p = await one<any>(
      `SELECT id, name, total_qty, maintenance_qty FROM products WHERE id = ?`,
      [u.product_id],
    );
    if (!p) continue;
    const effective = Math.max(0, p.total_qty - p.maintenance_qty);
    const holds = await holdsForProduct(u.product_id, from, to, null, reservationId, config);
    const used = peakUsage(holds, from, to);
    if (used > effective) {
      out.push({ product_id: p.id, product: p.name, effective, used, excess: used - effective });
    }
  }
  return out;
}

/**
 * Linha do tempo por produto fisico dentro da janela.
 *
 * Serve as telas de consulta: o numero unico responde "cabe?", enquanto os
 * trechos respondem "a partir de que hora libera?". Reusa as mesmas ocupacoes
 * do resto do motor, sem uma segunda regra de estoque.
 */
export async function timelinesByProduct(
  from: string,
  to: string,
  options: StockOptions = {},
): Promise<Map<number, Trecho[]>> {
  ({ from, to } = timeWindow(from, to, true));
  const [produtos, rows] = await Promise.all([
    all<any>(
      `SELECT id, total_qty, maintenance_qty FROM products WHERE active = 1 AND kind <> 'kit'`,
    ),
    loadHoldsInner(from, to, options),
  ]);

  const porProduto = new Map<number, Hold[]>();
  for (const r of rows) {
    const lista = porProduto.get(r.product_id) ?? [];
    lista.push(r);
    porProduto.set(r.product_id, lista);
  }

  const saida = new Map<number, Trecho[]>();
  for (const p of produtos) {
    const efetivo = Math.max(0, p.total_qty - p.maintenance_qty);
    saida.set(p.id, availabilityTimeline(porProduto.get(p.id) ?? [], efetivo, from, to));
  }
  return saida;
}

/* ------------------------------------------------------------------ */
/* Agrupamentos para telas de consulta                                 */
/* ------------------------------------------------------------------ */

/**
 * Resumo por categoria para a tela de disponibilidade.
 * Os totais somam apenas produtos fisicos; kits entram como linha derivada.
 */
export async function availabilityByCategory(from: string, to: string, options: StockOptions = {}) {
  const rows = await availabilityAllWithKits(from, to, null, options);
  const groups = new Map<string, Availability[]>();
  for (const r of rows) {
    const key = r.category ?? "Sem categoria";
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  return [...groups.entries()].map(([category, products]) => {
    const fisicos = products.filter((p) => p.kind !== "kit");
    return {
      category,
      products,
      total: fisicos.reduce((s, p) => s + p.total, 0),
      reserved: fisicos.reduce((s, p) => s + p.reserved, 0),
      available: fisicos.reduce((s, p) => s + Math.max(0, p.available), 0),
    };
  });
}

export { expandDemand, explodeLine, kitCapacity, isKit, conflictText };
