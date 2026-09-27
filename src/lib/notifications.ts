import "server-only";
import { all, batch } from "./db";
import { addDays, today } from "./format";
import { scanConflicts } from "./stock";

type Alert = {
  dedupe_key: string;
  type: string;
  severity: "info" | "aviso" | "critico";
  title: string;
  body?: string;
  link?: string;
};

const UPSERT_SQL = `INSERT INTO notifications (type, severity, title, body, link, dedupe_key)
   VALUES (?,?,?,?,?,?)
   ON CONFLICT(dedupe_key) DO UPDATE SET
     title = excluded.title, body = excluded.body, severity = excluded.severity, link = excluded.link`;

/**
 * Recalcula os alertas do sistema.
 *
 * Cada consulta ao D1 e uma ida e volta pela rede, entao a funcao evita
 * enfileirar chamadas: as leituras nao dependem umas das outras e saem juntas,
 * e todas as escritas vao num unico lote no final. Usa dedupe_key para nao
 * duplicar o mesmo aviso e remove os que deixaram de ser verdadeiros.
 */
export async function rebuildNotifications({ force = false } = {}) {
  // A varredura e cara e os alertas mudam devagar. Fora da tela de
  // notificacoes, um intervalo minimo evita refazer tudo a cada visita ao
  // painel sem atrasar nada que o usuario perceba.
  if (!force && !(await passouDoIntervalo())) return;

  const d0 = today();
  const d3 = addDays(d0, 3);

  const alertas: Alert[] = [];
  const push = (a: Alert) => alertas.push(a);

  const [ops, unpaid, soon, contracts, deposits, low, maint, conflitos] = await Promise.all([
    /* operacoes de hoje e atrasadas */
    all<any>(
      `SELECT o.*, c.name AS customer, r.number
         FROM operations o
         LEFT JOIN reservations r ON r.id = o.reservation_id
         LEFT JOIN customers c ON c.id = r.customer_id
        WHERE o.status NOT IN ('concluida','cancelada')
          /* comparacao direta na coluna (sargable): '<hoje>T23:59' cobre o dia
             inteiro e permite o uso do indice idx_op_sched */
          AND o.scheduled_at <= ?`,
      [`${d0}T23:59`],
    ),
    /* pagamentos pendentes de reservas ja entregues ou com evento passado */
    all<any>(
      `SELECT r.id, r.number, r.event_date, r.total_cents, c.name AS customer,
              (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.reservation_id = r.id) AS paid
         FROM reservations r JOIN customers c ON c.id = r.customer_id
        WHERE r.status NOT IN ('cancelada','orcamento')
          AND r.event_date <= ?
          AND r.total_cents > (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.reservation_id = r.id)`,
      [d0],
    ),
    /* reservas proximas ainda como pre-reserva */
    all<any>(
      `SELECT r.id, r.number, r.event_date, c.name AS customer
         FROM reservations r JOIN customers c ON c.id = r.customer_id
        WHERE r.status = 'pre_reserva' AND r.event_date BETWEEN ? AND ?`,
      [d0, d3],
    ),
    /* contratos nao assinados de eventos proximos */
    all<any>(
      `SELECT r.id, r.number, r.event_date, c.name AS customer,
              (SELECT ct.status FROM contracts ct WHERE ct.reservation_id = r.id ORDER BY ct.id DESC LIMIT 1) AS cstatus
         FROM reservations r JOIN customers c ON c.id = r.customer_id
        WHERE r.status IN ('confirmada','entregue','em_uso') AND r.event_date BETWEEN ? AND ?`,
      [d0, d3],
    ),
    /* caucao nao recebida em reservas confirmadas */
    all<any>(
      `SELECT r.id, r.number, c.name AS customer, d.amount_cents, d.status
         FROM reservations r
         JOIN customers c ON c.id = r.customer_id
         JOIN deposits d ON d.reservation_id = r.id
        WHERE d.status = 'nao_recebida' AND d.amount_cents > 0
          AND r.status IN ('confirmada','entregue','em_uso','aguardando_retirada')`,
    ),
    /* estoque baixo: kits nao tem estoque proprio e ficam de fora */
    all<any>(
      `SELECT id, name, total_qty, maintenance_qty, min_qty FROM products
        WHERE active = 1 AND kind <> 'kit' AND min_qty > 0 AND (total_qty - maintenance_qty) < min_qty`,
    ),
    /* manutencoes abertas */
    all<any>(
      `SELECT m.id, m.qty, p.name FROM maintenance m JOIN products p ON p.id = m.product_id WHERE m.status = 'aberta'`,
    ),
    /* conflitos de estoque em reservas futuras (uma varredura, sem N+1) */
    scanConflicts(d0),
  ]);

  for (const o of ops) {
    const late = o.scheduled_at.slice(0, 10) < d0;
    push({
      dedupe_key: `op-${o.id}`,
      type: o.kind,
      severity: late ? "critico" : "aviso",
      title: `${late ? "Atrasada" : "Hoje"}: ${o.kind} · ${o.customer ?? "sem cliente"}`,
      body: `${o.number ?? ""} agendada para ${o.scheduled_at.replace("T", " ")}`,
      link: o.reservation_id ? `/reservas/${o.reservation_id}` : "/operacao",
    });
  }

  for (const r of unpaid) {
    push({
      dedupe_key: `pay-${r.id}`,
      type: "pagamento",
      severity: "critico",
      title: `Pagamento pendente · ${r.customer}`,
      body: `${r.number}: saldo de R$ ${((r.total_cents - r.paid) / 100).toFixed(2)}`,
      link: `/reservas/${r.id}`,
    });
  }

  for (const r of soon) {
    push({
      dedupe_key: `soon-${r.id}`,
      type: "reserva",
      severity: "aviso",
      title: `Pré-reserva próxima · ${r.customer}`,
      body: `${r.number} para ${r.event_date}. Confirmar com o cliente.`,
      link: `/reservas/${r.id}`,
    });
  }

  for (const r of contracts) {
    if (r.cstatus === "assinado") continue;
    push({
      dedupe_key: `contract-${r.id}`,
      type: "contrato",
      severity: "aviso",
      title: `Contrato pendente · ${r.customer}`,
      body: `${r.number}: ${r.cstatus ? "contrato " + r.cstatus : "contrato ainda não gerado"}.`,
      link: `/reservas/${r.id}`,
    });
  }

  for (const r of deposits) {
    push({
      dedupe_key: `deposit-${r.id}`,
      type: "caucao",
      severity: "aviso",
      title: `Caução não recebida · ${r.customer}`,
      body: `${r.number}: R$ ${(r.amount_cents / 100).toFixed(2)} pendente.`,
      link: `/reservas/${r.id}`,
    });
  }

  for (const p of low) {
    push({
      dedupe_key: `low-${p.id}`,
      type: "estoque",
      severity: "aviso",
      title: `Estoque baixo: ${p.name}`,
      body: `${p.total_qty - p.maintenance_qty} disponíveis, mínimo ${p.min_qty}.`,
      link: `/estoque/${p.id}`,
    });
  }

  for (const m of maint) {
    push({
      dedupe_key: `maint-${m.id}`,
      type: "manutencao",
      severity: "info",
      title: `Manutenção aberta: ${m.name}`,
      body: `${m.qty} unidade(s) fora de operação.`,
      link: `/estoque`,
    });
  }

  for (const r of conflitos) {
    push({
      dedupe_key: `conflict-${r.reservation_id}`,
      type: "conflito",
      severity: "critico",
      title: `Conflito de estoque · ${r.customer}`,
      body: `${r.number}: ${r.faltas.map((f) => `${f.product} faltam ${f.missing}`).join("; ")}`,
      link: `/reservas/${r.reservation_id}`,
    });
  }

  /* grava tudo de uma vez: os alertas atuais e a limpeza dos que sairam */
  const keep = alertas.map((a) => a.dedupe_key);
  const escritas: { sql: string; params: any[] }[] = alertas.map((a) => ({
    sql: UPSERT_SQL,
    params: [a.type, a.severity, a.title, a.body ?? null, a.link ?? null, a.dedupe_key],
  }));
  escritas.push(
    keep.length
      ? {
          sql: `DELETE FROM notifications WHERE dedupe_key IS NOT NULL AND dedupe_key NOT IN (${keep
            .map(() => "?")
            .join(",")})`,
          params: keep,
        }
      : { sql: `DELETE FROM notifications WHERE dedupe_key IS NOT NULL`, params: [] },
  );
  escritas.push({
    sql: `INSERT INTO settings (key, value) VALUES ('notifications_rebuilt_at', ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    params: [String(Date.now())],
  });
  await batch(escritas);
}

const INTERVALO_MS = 60_000;

async function passouDoIntervalo(): Promise<boolean> {
  const r = await all<{ value: string }>(`SELECT value FROM settings WHERE key = 'notifications_rebuilt_at'`);
  const ultimo = Number(r[0]?.value ?? 0);
  return !Number.isFinite(ultimo) || Date.now() - ultimo > INTERVALO_MS;
}

export async function listNotifications(onlyUnread = false) {
  return await all<any>(
    `SELECT * FROM notifications ${onlyUnread ? "WHERE read_at IS NULL" : ""}
      ORDER BY CASE severity WHEN 'critico' THEN 0 WHEN 'aviso' THEN 1 ELSE 2 END, id DESC
      LIMIT 200`,
  );
}

export async function unreadCount(): Promise<number> {
  const r = await all<{ n: number }>(`SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL`);
  return r[0]?.n ?? 0;
}
