import "server-only";
import { all, one, run } from "./db";
import { explodeLine, isKit, type SpecMap } from "./kits";
import { loadSpecs } from "./stock";
import { commitStockBatch, stockVersion } from "./stock-write";
import { logAction } from "./audit";
import type { SessionUser } from "./auth";
import { today } from "./format";

/**
 * Resolucao de danos: baixa definitiva e manutencao, com rastreabilidade.
 *
 * Regra central (auditoria de estoque): registrar o dano documenta a ocorrencia,
 * mas nao tira a unidade de circulacao. A disponibilidade e derivada de
 * products.total_qty - maintenance_qty menos as ocupacoes das reservas, entao
 * resolver o dano significa mover um desses dois contadores — e gravar a
 * movimentacao correspondente no livro stock_movements (o mesmo das compras),
 * com vinculo para o dano e para a reserva de origem.
 *
 * Regras invariantes:
 *  - Kit nunca e baixado diretamente: a linha comercial e expandida nos
 *    componentes fisicos (explodeLine), porque so produto simples tem estoque.
 *  - Baixa e idempotente: so parte de resolution_status 'registrada',
 *    'estornada' ou 'consertada'; o paralelo e barrado pelo CAS do
 *    stock_revision dentro do commitStockBatch.
 *  - Cancelamento/exclusao de reserva nunca reverte baixa: o estorno e um
 *    movimento proprio (estorno_baixa), com motivo.
 *  - Historico nunca e apagado: estorno e movimentacao inversa, nunca DELETE.
 */

export type DamageRow = {
  id: number;
  reservation_id: number | null;
  product_id: number | null;
  product_unit_id: number | null;
  qty: number;
  resolution_status: string;
  resolution_action: string | null;
  maintenance_id: number | null;
};

export const RESOLUTION_LABEL: Record<string, string> = {
  registrada: "Registrada",
  baixada: "Baixada do estoque",
  em_manutencao: "Em manutenção",
  consertada: "Consertada",
  estornada: "Baixa estornada",
};

const RESOLVABLE_FROM = ["registrada", "estornada", "consertada"];

/* ------------------------------------------------------------------ */
/* Consultas                                                           */
/* ------------------------------------------------------------------ */

/** Movimentacoes de estoque geradas por um dano (baixa e estornos). */
export async function damageMovements(damageId: number) {
  return await all<any>(
    `SELECT m.*, p.name AS product_name FROM stock_movements m
       JOIN products p ON p.id = m.product_id
      WHERE m.damage_report_id = ? ORDER BY m.id`,
    [damageId],
  );
}

/* ------------------------------------------------------------------ */
/* Expansao comercial -> fisica                                        */
/* ------------------------------------------------------------------ */

/**
 * Converte a linha do dano em consumo fisico por produto simples.
 *
 * Produto simples: 2 Cadeira  -> [{ Cadeira, 2 }]
 * Kit (1 Mesa+4 Cad): 1 Kit   -> [{ Mesa, 1 }, { Cadeira, 4 }]
 */
export function expandDamageLine(productId: number, qty: number, specs: SpecMap) {
  return explodeLine({ product_id: productId, qty }, specs);
}

/** Timestamp local no formato usado por resolved_at. */
function agoraLocal(): string {
  return today() + " " + new Date().toTimeString().slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* Resolucao                                                           */
/* ------------------------------------------------------------------ */

/**
 * Resolve um dano registrado, escolhendo o destino das unidades.
 *
 * action = 'baixa'      -> perda definitiva: total_qty -= q por produto fisico
 *                          e movimentacao 'baixa_dano' no livro.
 * action = 'manutencao' -> consertavel: abre manutencao (maintenance_qty += q,
 *                          indisponivel ate a conclusao) e registra o par.
 *
 * Toda a escrita acontece num unico batch atomico com CAS de revisao, entao
 * duas resolucoes concorrentes do mesmo dano produzem exatamente uma baixa.
 */
export async function resolveDamage(
  user: SessionUser,
  damageId: number,
  action: "baixa" | "manutencao",
  opts: { notes?: string; maintenanceCostCents?: number } = {},
): Promise<{ ok: true } | { ok: false; erro: string }> {
  const d = await one<DamageRow>(
    `SELECT id, reservation_id, product_id, product_unit_id, qty, resolution_status, resolution_action, maintenance_id
       FROM damage_reports WHERE id = ?`,
    [damageId],
  );
  if (!d) return { ok: false, erro: "Dano não encontrado." };
  if (!d.product_id) return { ok: false, erro: "O dano precisa estar vinculado a um equipamento." };
  if (!RESOLVABLE_FROM.includes(d.resolution_status)) {
    return { ok: false, erro: `Este dano já está resolvido (${RESOLUTION_LABEL[d.resolution_status] ?? d.resolution_status}).` };
  }

  const specs = await loadSpecs();
  const spec = specs.get(d.product_id);
  const parts = expandDamageLine(d.product_id, d.qty, specs);
  if (!parts.length) return { ok: false, erro: "Quantidade do dano inválida." };

  const version = await stockVersion();
  const nowLocal = agoraLocal();
  const origem = d.reservation_id ? `reserva #${d.reservation_id}` : "sem reserva vinculada";
  const destino = action === "baixa" ? "baixa definitiva" : "manutenção";

  if (action === "manutencao" && isKit(spec)) {
    // manutencao por unidade fisica so existe agregada no produto simples
    return { ok: false, erro: "Para kit, envie para manutenção os componentes individuais." };
  }

  const statements: { sql: string; params?: any[] }[] = [];

  if (action === "baixa") {
    for (const part of parts) {
      const nome = specs.get(part.product_id)?.name ?? `Produto ${part.product_id}`;
      // baixa definitiva: reduz o patrimonio disponivel do produto fisico
      statements.push({
        sql: `UPDATE products SET total_qty = MAX(0, total_qty - ?) WHERE id = ?`,
        params: [part.qty, part.product_id],
      });
      // livro de movimentacoes: a baixa fica registrada com origem completa
      statements.push({
        sql: `INSERT INTO stock_movements (product_id, qty_delta, reason, damage_report_id, reservation_id, notes, created_by)
              VALUES (?,?,?,?,?,?,?)`,
        params: [
          part.product_id,
          -part.qty,
          "baixa_dano",
          d.id,
          d.reservation_id ?? null,
          `Dano #${d.id} · ${nome} · ${origem}${opts.notes ? ` · ${opts.notes}` : ""}`,
          user.id,
        ],
      });
    }
  } else {
    // consertavel: abre o par de manutencao (reaproveita o fluxo existente,
    // que ja move maintenance_qty e devolve o disponivel ao concluir)
    statements.push({
      sql: `INSERT INTO maintenance (product_id, product_unit_id, qty, reason, started_at, status, cost_cents, notes, created_by, damage_report_id)
            VALUES (?,?,?,?,?, 'aberta', ?,?,?,?)`,
      params: [
        d.product_id,
        d.product_unit_id ?? null,
        d.qty,
        `${destino} por dano #${d.id} (${origem})`,
        today(),
        opts.maintenanceCostCents ?? 0,
        opts.notes ?? null,
        user.id,
        d.id,
      ],
    });
    statements.push({
      sql: `UPDATE products SET maintenance_qty = MIN(total_qty, maintenance_qty + ?) WHERE id = ?`,
      params: [d.qty, d.product_id],
    });
    if (d.product_unit_id) {
      statements.push({ sql: `UPDATE product_units SET status = 'manutencao' WHERE id = ?`, params: [d.product_unit_id] });
    }
  }

  const novoStatus = action === "baixa" ? "baixada" : "em_manutencao";
  statements.push({
    sql: `UPDATE damage_reports
             SET resolution_status = ?, resolution_action = ?, resolved_at = ?, resolved_by = ?,
                 resolution_notes = COALESCE(NULLIF(?,''), resolution_notes)
           WHERE id = ? AND resolution_status IN ('registrada','estornada','consertada')`,
    params: [novoStatus, action, nowLocal, user.id, opts.notes ?? "", d.id],
  });

  try {
    await commitStockBatch(version, statements);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (msg.includes("stock_version_matches")) return { ok: false, erro: "O estoque mudou durante a operação. Nada foi alterado; tente novamente." };
    if (msg.includes("STOCK_CHANGED") || msg.includes("O estoque ou a reserva mudou")) return { ok: false, erro: msg };
    throw e;
  }

  if (action === "manutencao") {
    // o INSERT roda no mesmo batch, entao o id da manutencao so existe agora;
    // o vinculo tambem ja fica registrado em maintenance.damage_report_id
    await run(
      `UPDATE damage_reports SET maintenance_id = (SELECT id FROM maintenance WHERE damage_report_id = ? ORDER BY id DESC LIMIT 1) WHERE id = ?`,
      [d.id, d.id],
    );
  }

  const resolvida = await one<{ id: number }>(`SELECT id FROM damage_reports WHERE id = ? AND resolution_status = ?`, [d.id, novoStatus]);
  if (!resolvida) return { ok: false, erro: "O dano mudou de estado durante a operação. Nada foi alterado; confira e tente novamente." };

  await logAction(
    user,
    action === "baixa" ? "baixa_dano" : "manutencao_dano",
    "reserva",
    d.reservation_id ?? null,
    `${user.name} resolveu o dano #${d.id} como ${destino} (${parts.map((p) => `${p.qty} un.`).join(", ")})`,
    { damage: d.id, action, parts },
  );

  return { ok: true };
}

/**
 * Conclui a manutencao aberta a partir de um dano: o item volta a ficar
 * disponivel e o dano fica marcado como consertado.
 * Reaproveita o mesmo efeito de closeMaintenance, amarrado ao registro do dano.
 */
export async function completeDamageMaintenance(user: SessionUser, damageId: number): Promise<{ ok: true } | { ok: false; erro: string }> {
  const d = await one<DamageRow>(`SELECT id, product_id, qty, maintenance_id, resolution_status FROM damage_reports WHERE id = ?`, [damageId]);
  if (!d) return { ok: false, erro: "Dano não encontrado." };
  if (d.resolution_status !== "em_manutencao") return { ok: false, erro: "Este dano não está em manutenção." };

  // caminho preferencial pelo id espelhado no dano; fallback pelo vinculo da
  // propria manutencao, caso o espelho esteja vazio ou a conclusao tenha
  // vindo pela tela de estoque
  const m =
    (d.maintenance_id && (await one<any>(`SELECT * FROM maintenance WHERE id = ?`, [d.maintenance_id]))) ||
    (await one<any>(`SELECT * FROM maintenance WHERE damage_report_id = ? ORDER BY id DESC LIMIT 1`, [d.id]));
  if (!m) return { ok: false, erro: "Manutenção vinculada não encontrada." };

  if (m.status === "concluida") {
    // concluida por outro caminho (ex.: tela de estoque): so alinha o estado
    // do dano; o estoque ja foi devolvido por quem concluiu
    await run(
      `UPDATE damage_reports SET resolution_status = 'consertada', resolved_at = ?, resolved_by = ? WHERE id = ? AND resolution_status = 'em_manutencao'`,
      [agoraLocal(), user.id, d.id],
    );
    await logAction(user, "consertar_dano", "reserva", d.reservation_id ?? null, `${user.name} alinou o dano #${d.id}: manutenção já concluída, item de volta ao disponível`, { damage: d.id });
    return { ok: true };
  }
  if (m.status !== "aberta") return { ok: false, erro: "A manutenção já foi concluída." };

  const version = await stockVersion();
  try {
    await commitStockBatch(version, [
      { sql: `UPDATE maintenance SET status = 'concluida', ended_at = ? WHERE id = ? AND status = 'aberta'`, params: [today(), d.maintenance_id] },
      { sql: `UPDATE products SET maintenance_qty = MAX(0, maintenance_qty - ?) WHERE id = ?`, params: [m.qty, d.product_id] },
      { sql: `UPDATE damage_reports SET resolution_status = 'consertada', resolved_at = ?, resolved_by = ? WHERE id = ? AND resolution_status = 'em_manutencao'`, params: [agoraLocal(), user.id, d.id] },
    ]);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (msg.includes("stock_version_matches")) return { ok: false, erro: "O estoque mudou durante a operação. Nada foi alterado; tente novamente." };
    throw e;
  }
  if (m.product_unit_id) await run(`UPDATE product_units SET status = 'disponivel' WHERE id = ?`, [m.product_unit_id]);

  await logAction(user, "consertar_dano", "reserva", d.reservation_id ?? null, `${user.name} concluiu a manutenção do dano #${d.id}: ${m.qty} un. de volta ao disponível`, { damage: d.id });
  return { ok: true };
}

/**
 * Estorna uma baixa definitiva: devolve as unidades ao patrimonio por
 * movimentacao inversa ('estorno_baixa', +q) e marca o dano como estornado.
 * O historico nunca e apagado; de 'estornada' o dano pode ser resolvido de novo.
 */
export async function revertDamageWriteOff(user: SessionUser, damageId: number, motivo: string): Promise<{ ok: true } | { ok: false; erro: string }> {
  const d = await one<DamageRow>(`SELECT id, reservation_id, product_id, qty, resolution_status, resolution_action FROM damage_reports WHERE id = ?`, [damageId]);
  if (!d) return { ok: false, erro: "Dano não encontrado." };
  if (d.resolution_status !== "baixada" || d.resolution_action !== "baixa") {
    return { ok: false, erro: "Só é possível estornar uma baixa definitiva." };
  }

  const baixas = await all<{ product_id: number; qty_delta: number }>(
    `SELECT product_id, qty_delta FROM stock_movements WHERE damage_report_id = ? AND reason = 'baixa_dano'`,
    [damageId],
  );
  if (!baixas.length) return { ok: false, erro: "Movimentação de baixa não encontrada para este dano." };

  const version = await stockVersion();
  const statements: { sql: string; params?: any[] }[] = [];
  for (const m of baixas) {
    const devolve = Math.abs(m.qty_delta);
    statements.push({
      sql: `UPDATE products SET total_qty = total_qty + ? WHERE id = ?`,
      params: [devolve, m.product_id],
    });
    statements.push({
      sql: `INSERT INTO stock_movements (product_id, qty_delta, reason, damage_report_id, reservation_id, notes, created_by)
            VALUES (?,?,?,?,?,?,?)`,
      params: [
        m.product_id,
        devolve,
        "estorno_baixa",
        d.id,
        d.reservation_id ?? null,
        `Estorno da baixa do dano #${d.id}${motivo ? ` · ${motivo}` : ""}`,
        user.id,
      ],
    });
  }
  statements.push({
    sql: `UPDATE damage_reports SET resolution_status = 'estornada', resolved_at = ?, resolved_by = ? WHERE id = ? AND resolution_status = 'baixada'`,
    params: [agoraLocal(), user.id, d.id],
  });

  try {
    await commitStockBatch(version, statements);
  } catch (e) {
    const msg = String((e as Error).message ?? e);
    if (msg.includes("stock_version_matches")) return { ok: false, erro: "O estoque mudou durante a operação. Nada foi alterado; tente novamente." };
    throw e;
  }
  const estornada = await one<{ id: number }>(`SELECT id FROM damage_reports WHERE id = ? AND resolution_status = 'estornada'`, [d.id]);
  if (!estornada) return { ok: false, erro: "O dano mudou de estado durante a operação. Nada foi alterado; confira e tente novamente." };

  await logAction(user, "estorno_baixa", "reserva", d.reservation_id ?? null, `${user.name} estornou a baixa do dano #${d.id}`, { damage: d.id, motivo });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Utilitarios de validacao usados pela UI                             */
/* ------------------------------------------------------------------ */

/**
 * Valida a quantidade do dano contra a linha comercial da reserva.
 * Usado antes de aceitar o registro (reportDamage) e na resolucao.
 * Kit e validado pela linha comercial (o cliente contratou o kit inteiro).
 */
export async function validarQuantidadeDoDano(reservationId: number, productId: number, qty: number): Promise<string | null> {
  const linha = await one<{ qty: number }>(
    `SELECT qty FROM reservation_items WHERE reservation_id = ? AND product_id = ? LIMIT 1`,
    [reservationId, productId],
  );
  if (!linha) return "O equipamento informado não pertence aos itens desta reserva.";
  if (qty > linha.qty) return `Quantidade maior que a contratada na reserva (${linha.qty}).`;
  return null;
}

/** Danos de uma reserva com estado de resolucao, para as telas. */
export async function damagesOfReservation(reservationId: number) {
  return await all<any>(
    `SELECT d.*, p.name AS product_name, p.kind AS product_kind, u.name AS resolved_by_name
       FROM damage_reports d
       LEFT JOIN products p ON p.id = d.product_id
       LEFT JOIN users u ON u.id = d.resolved_by
      WHERE d.reservation_id = ? ORDER BY d.id DESC`,
    [reservationId],
  );
}
