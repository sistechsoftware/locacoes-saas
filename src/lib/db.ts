import { getCloudflareContext } from "@opennextjs/cloudflare";

type Row = Record<string, any>;

declare global {
  // eslint-disable-next-line no-var
  var __limasTestDb: D1Database | undefined;
}

/**
 * Banco da requisicao atual.
 *
 * Em producao vem do binding D1 do Worker. Os testes automatizados injetam um
 * D1 compativel em globalThis para exercitar as mesmas consultas SQL sem
 * precisar de infraestrutura Cloudflare.
 */
/**
 * Banco fornecido explicitamente por quem roda fora de uma requisicao.
 *
 * O cron do Worker nao tem contexto de requisicao, entao getCloudflareContext()
 * nao serve la. Em vez de duplicar todo o acesso a dados so para o agendador,
 * ele passa o binding por aqui. Todas as execucoes usam o mesmo env.DB, entao
 * uma sobreposicao momentanea nao muda o banco de ninguem.
 */
let dbDoAgendador: D1Database | undefined;

export async function runWithDb<T>(db: D1Database, fn: () => Promise<T>): Promise<T> {
  const anterior = dbDoAgendador;
  dbDoAgendador = db;
  try {
    return await fn();
  } finally {
    dbDoAgendador = anterior;
  }
}

export function getDb(): D1Database {
  if (globalThis.__limasTestDb) return globalThis.__limasTestDb;
  if (dbDoAgendador) return dbDoAgendador;
  return getCloudflareContext().env.DB;
}

/* ------------------------------------------------------------------ */
/* Helpers de consulta                                                 */
/* ------------------------------------------------------------------ */

export async function all<T = Row>(sql: string, params: any[] = []): Promise<T[]> {
  const db = getDb();
  const result = await db.prepare(sql).bind(...normalize(params)).all<T>();
  return result.results.map(plain) as T[];
}

export async function one<T = Row>(sql: string, params: any[] = []): Promise<T | undefined> {
  const db = getDb();
  const row = await db.prepare(sql).bind(...normalize(params)).first<T>();
  return row === null ? undefined : (plain(row) as T);
}

/**
 * Mantem os resultados do D1 como objetos simples antes de entrega-los aos
 * Client Components do React.
 */
function plain<T>(row: T): T {
  return { ...(row as object) } as T;
}

export async function run(sql: string, params: any[] = []) {
  const db = getDb();
  return db.prepare(sql).bind(...normalize(params)).run();
}

export async function insert(sql: string, params: any[] = []): Promise<number> {
  const result = await run(sql, params);
  return Number(result.meta.last_row_id);
}

export async function scalar<T = number>(sql: string, params: any[] = []): Promise<T> {
  const r = await one<Row>(sql, params);
  if (!r) return 0 as unknown as T;
  return Object.values(r)[0] as T;
}

/** SQLite nao aceita boolean/undefined/Date: normaliza para tipos suportados. */
function normalize(params: any[]): any[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === "object" && p !== null) return JSON.stringify(p);
    return p;
  });
}

/**
 * Agrupa escritas relacionadas.
 *
 * O D1 nao oferece transacao interativa (BEGIN/COMMIT dirigido pela
 * aplicacao), apenas `batch()` para um conjunto de statements ja conhecido.
 * Este helper legado NAO e uma transacao. Escritas que alteram a ocupacao de
 * reservas usam stock-write.ts: revisao otimista e batch atomico real.
 */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

/** Executa varios statements atomicamente (transacao unica no D1). */
export async function batch(statements: { sql: string; params?: any[] }[]) {
  if (!statements.length) return [];
  const db = getDb();
  return db.batch(statements.map((s) => db.prepare(s.sql).bind(...normalize(s.params ?? []))));
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'operador' CHECK (role IN ('admin','operador')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  name   TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  doc        TEXT,
  phone      TEXT,
  whatsapp   TEXT,
  email      TEXT,
  address    TEXT,
  district   TEXT,
  city       TEXT,
  zip        TEXT,
  notes      TEXT,
  is_demo    INTEGER NOT NULL DEFAULT 0,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);

/*
 * kind = 'simples' | 'kit'.
 * Kits nao possuem estoque proprio: total_qty fica em 0 e a disponibilidade
 * e derivada dos componentes (ver product_components).
 */
CREATE TABLE IF NOT EXISTS products (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  category_id       INTEGER REFERENCES categories(id),
  kind              TEXT NOT NULL DEFAULT 'simples',
  total_qty         INTEGER NOT NULL DEFAULT 0,
  maintenance_qty   INTEGER NOT NULL DEFAULT 0,
  min_qty           INTEGER NOT NULL DEFAULT 0,
  rent_price_cents  INTEGER NOT NULL DEFAULT 0,
  replace_cents     INTEGER NOT NULL DEFAULT 0,
  description       TEXT,
  photo             TEXT,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

/* Composicao dos kits: apenas produtos simples podem ser componentes. */
CREATE TABLE IF NOT EXISTS product_components (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity             INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (parent_product_id, component_product_id),
  CHECK (parent_product_id <> component_product_id)
);
CREATE INDEX IF NOT EXISTS idx_pcomp_parent ON product_components(parent_product_id);
CREATE INDEX IF NOT EXISTS idx_pcomp_component ON product_components(component_product_id);

CREATE TABLE IF NOT EXISTS product_units (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  code         TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'disponivel'
               CHECK (status IN ('disponivel','reservado','alugado','manutencao','danificado','baixado')),
  photo        TEXT,
  acquired_at  TEXT,
  value_cents  INTEGER NOT NULL DEFAULT 0,
  condition    TEXT DEFAULT 'bom',
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_units_product ON product_units(product_id);

CREATE TABLE IF NOT EXISTS reservations (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  number            TEXT NOT NULL UNIQUE,
  customer_id       INTEGER NOT NULL REFERENCES customers(id),
  status            TEXT NOT NULL DEFAULT 'pre_reserva',
  event_date        TEXT NOT NULL,
  event_time        TEXT,
  address           TEXT,
  district          TEXT,
  city              TEXT,
  delivery_at       TEXT,
  pickup_at         TEXT,
  needs_delivery    INTEGER NOT NULL DEFAULT 1,
  needs_pickup      INTEGER NOT NULL DEFAULT 1,
  needs_assembly    INTEGER NOT NULL DEFAULT 0,
  needs_disassembly INTEGER NOT NULL DEFAULT 0,
  items_cents       INTEGER NOT NULL DEFAULT 0,
  freight_cents     INTEGER NOT NULL DEFAULT 0,
  assembly_cents    INTEGER NOT NULL DEFAULT 0,
  disassembly_cents INTEGER NOT NULL DEFAULT 0,
  other_cents       INTEGER NOT NULL DEFAULT 0,
  discount_cents    INTEGER NOT NULL DEFAULT 0,
  total_cents       INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  cancel_reason     TEXT,
  stock_override    INTEGER NOT NULL DEFAULT 0,
  quote_id          INTEGER,
  is_demo           INTEGER NOT NULL DEFAULT 0,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_res_customer ON reservations(customer_id);
CREATE INDEX IF NOT EXISTS idx_res_event ON reservations(event_date);
CREATE INDEX IF NOT EXISTS idx_res_status ON reservations(status);

CREATE TABLE IF NOT EXISTS reservation_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id   INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL REFERENCES products(id),
  qty              INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents   INTEGER NOT NULL DEFAULT 0,
  subtotal_cents   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ritems_res ON reservation_items(reservation_id);
CREATE INDEX IF NOT EXISTS idx_ritems_prod ON reservation_items(product_id);

/*
 * Expansao fisica das linhas da reserva.
 *
 * reservation_items guarda a linha COMERCIAL (o que o cliente contratou e
 * enxerga: "10 x Kit Mesa + 4 Cadeiras"). Esta tabela guarda o consumo FISICO
 * correspondente ("10 Mesas, 40 Cadeiras"), que e o que ocupa estoque.
 *
 * Produtos simples geram uma linha 1:1. A fotografia e feita no momento da
 * operacao, de modo que alterar a composicao de um kit depois nao altera
 * reservas ja registradas.
 */
CREATE TABLE IF NOT EXISTS reservation_item_components (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id      INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  reservation_item_id INTEGER NOT NULL REFERENCES reservation_items(id) ON DELETE CASCADE,
  product_id          INTEGER NOT NULL REFERENCES products(id),
  qty_per_unit        INTEGER NOT NULL DEFAULT 1,
  qty                 INTEGER NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ricomp_res ON reservation_item_components(reservation_id);
CREATE INDEX IF NOT EXISTS idx_ricomp_item ON reservation_item_components(reservation_item_id);
CREATE INDEX IF NOT EXISTS idx_ricomp_prod ON reservation_item_components(product_id);

CREATE TABLE IF NOT EXISTS quotes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  number            TEXT NOT NULL UNIQUE,
  customer_id       INTEGER NOT NULL REFERENCES customers(id),
  status            TEXT NOT NULL DEFAULT 'rascunho',
  event_date        TEXT,
  event_time        TEXT,
  address           TEXT,
  district          TEXT,
  city              TEXT,
  delivery_at       TEXT,
  pickup_at         TEXT,
  valid_until       TEXT,
  items_cents       INTEGER NOT NULL DEFAULT 0,
  freight_cents     INTEGER NOT NULL DEFAULT 0,
  assembly_cents    INTEGER NOT NULL DEFAULT 0,
  disassembly_cents INTEGER NOT NULL DEFAULT 0,
  other_cents       INTEGER NOT NULL DEFAULT 0,
  discount_cents    INTEGER NOT NULL DEFAULT 0,
  total_cents       INTEGER NOT NULL DEFAULT 0,
  notes             TEXT,
  reservation_id    INTEGER REFERENCES reservations(id),
  is_demo           INTEGER NOT NULL DEFAULT 0,
  created_by        INTEGER REFERENCES users(id),
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS quote_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  quote_id         INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  product_id       INTEGER NOT NULL REFERENCES products(id),
  qty              INTEGER NOT NULL DEFAULT 1,
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  discount_cents   INTEGER NOT NULL DEFAULT 0,
  subtotal_cents   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_qitems_quote ON quote_items(quote_id);

CREATE TABLE IF NOT EXISTS payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
  freight_id     INTEGER REFERENCES freights(id) ON DELETE CASCADE,
  amount_cents   INTEGER NOT NULL,
  method         TEXT NOT NULL DEFAULT 'pix',
  paid_at        TEXT NOT NULL,
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  /* ligacao opcional com a parcela prevista (ver financial_entries) */
  entry_id       INTEGER REFERENCES financial_entries(id) ON DELETE SET NULL,
  account_id     INTEGER REFERENCES financial_accounts(id) ON DELETE SET NULL,
  reconciled_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_pay_res ON payments(reservation_id);
CREATE INDEX IF NOT EXISTS idx_pay_date ON payments(paid_at);

CREATE TABLE IF NOT EXISTS deposits (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  amount_cents   INTEGER NOT NULL DEFAULT 0,
  method         TEXT,
  received_at    TEXT,
  returned_at    TEXT,
  status         TEXT NOT NULL DEFAULT 'nao_recebida'
                 CHECK (status IN ('nao_recebida','recebida','devolvida','retida_parcial','retida_integral')),
  retained_cents INTEGER NOT NULL DEFAULT 0,
  reason         TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_dep_res ON deposits(reservation_id);

CREATE TABLE IF NOT EXISTS expenses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT NOT NULL,
  category       TEXT NOT NULL,
  description    TEXT,
  amount_cents   INTEGER NOT NULL,
  method         TEXT DEFAULT 'pix',
  reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'pago',
  is_demo        INTEGER NOT NULL DEFAULT 0,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  entry_id       INTEGER REFERENCES financial_entries(id) ON DELETE SET NULL,
  account_id     INTEGER REFERENCES financial_accounts(id) ON DELETE SET NULL,
  supplier_id    INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  purchase_id    INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  reconciled_at  TEXT,
  /* separa investimento na estrutura de gasto para manter a operacao */
  kind           TEXT NOT NULL DEFAULT 'operacional'
);
CREATE INDEX IF NOT EXISTS idx_exp_date ON expenses(date);

CREATE TABLE IF NOT EXISTS vehicles (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  plate    TEXT,
  model    TEXT,
  capacity TEXT,
  notes    TEXT,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS freights (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       TEXT NOT NULL UNIQUE,
  customer_id  INTEGER REFERENCES customers(id),
  contact_name TEXT,
  phone        TEXT,
  date         TEXT NOT NULL,
  time         TEXT,
  origin       TEXT,
  destination  TEXT,
  cargo        TEXT,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  method       TEXT DEFAULT 'pix',
  status       TEXT NOT NULL DEFAULT 'orcamento'
               CHECK (status IN ('orcamento','agendado','em_rota','concluido','cancelado')),
  vehicle_id   INTEGER REFERENCES vehicles(id),
  notes        TEXT,
  is_demo      INTEGER NOT NULL DEFAULT 0,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_freight_date ON freights(date);

/*
 * Entregas, retiradas, montagens e desmontagens compartilham exatamente os
 * mesmos campos e o mesmo ciclo de status. Ficam numa tabela unica com a
 * coluna kind, e as views abaixo expoem cada uma pelo nome do dominio.
 */
CREATE TABLE IF NOT EXISTS operations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('entrega','retirada','montagem','desmontagem')),
  reservation_id INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
  freight_id     INTEGER REFERENCES freights(id) ON DELETE CASCADE,
  scheduled_at   TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pendente'
                 CHECK (status IN ('pendente','confirmada','em_rota','no_local','concluida','reagendada','cancelada')),
  assignee       TEXT,
  vehicle_id     INTEGER REFERENCES vehicles(id),
  notes          TEXT,
  completed_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_op_sched ON operations(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_op_res ON operations(reservation_id);
CREATE INDEX IF NOT EXISTS idx_op_kind ON operations(kind, status);

CREATE VIEW IF NOT EXISTS deliveries     AS SELECT * FROM operations WHERE kind = 'entrega';
CREATE VIEW IF NOT EXISTS pickups        AS SELECT * FROM operations WHERE kind = 'retirada';
CREATE VIEW IF NOT EXISTS assemblies     AS SELECT * FROM operations WHERE kind = 'montagem';
CREATE VIEW IF NOT EXISTS disassemblies  AS SELECT * FROM operations WHERE kind = 'desmontagem';

CREATE TABLE IF NOT EXISTS checklists (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id INTEGER NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  data         TEXT NOT NULL DEFAULT '{}',
  notes        TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_check_op ON checklists(operation_id);

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  entity     TEXT NOT NULL,
  entity_id  INTEGER NOT NULL,
  path       TEXT NOT NULL,
  caption    TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_att_entity ON attachments(entity, entity_id);

CREATE TABLE IF NOT EXISTS damage_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id  INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
  product_id      INTEGER REFERENCES products(id),
  product_unit_id INTEGER REFERENCES product_units(id),
  qty             INTEGER NOT NULL DEFAULT 1,
  damage_type     TEXT,
  description     TEXT,
  photo           TEXT,
  estimated_cents INTEGER NOT NULL DEFAULT 0,
  charged_cents   INTEGER NOT NULL DEFAULT 0,
  created_by      INTEGER REFERENCES users(id),
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  /* ciclo de resolucao (0023): registrada -> baixada | em_manutencao ->
     consertada | estornada. A baixa definitiva sai de total_qty e grava em
     stock_movements com o vinculo para este registro e a reserva. */
  resolution_status TEXT NOT NULL DEFAULT 'registrada'
                    CHECK (resolution_status IN ('registrada','baixada','em_manutencao','consertada','estornada')),
  resolution_action TEXT,
  resolved_at       TEXT,
  resolved_by       INTEGER REFERENCES users(id),
  resolution_notes  TEXT,
  maintenance_id    INTEGER REFERENCES maintenance(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_damages_resolution ON damage_reports(resolution_status);

CREATE TABLE IF NOT EXISTS maintenance (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  product_unit_id INTEGER REFERENCES product_units(id),
  qty             INTEGER NOT NULL DEFAULT 1,
  reason          TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  status          TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','concluida','cancelada')),
  cost_cents      INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_by      INTEGER REFERENCES users(id),
  /* manutencao aberta a partir de um dano (0023), para o estorno achar o par */
  damage_report_id INTEGER REFERENCES damage_reports(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_maintenance_damage ON maintenance(damage_report_id);

CREATE TABLE IF NOT EXISTS contracts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         TEXT NOT NULL UNIQUE,
  reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  status         TEXT NOT NULL DEFAULT 'pendente'
                 CHECK (status IN ('pendente','enviado','assinado','encerrado','cancelado')),
  body           TEXT NOT NULL,
  signer_name    TEXT,
  sent_at        TEXT,
  signed_at      TEXT,
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  body_frozen_at TEXT,
  /* assinatura da empresa ja cadastrada no momento da geracao (0019/0021) */
  company_signature_included INTEGER
);
CREATE INDEX IF NOT EXISTS idx_contract_res ON contracts(reservation_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT NOT NULL,
  severity   TEXT NOT NULL DEFAULT 'info',
  title      TEXT NOT NULL,
  body       TEXT,
  link       TEXT,
  dedupe_key TEXT UNIQUE,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  user_name  TEXT,
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  INTEGER,
  summary    TEXT NOT NULL,
  meta       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);

CREATE TABLE IF NOT EXISTS financial_accounts (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  name                  TEXT NOT NULL,
  kind                  TEXT NOT NULL DEFAULT 'banco'
                        CHECK (kind IN ('banco','dinheiro','digital','poupanca','outro')),
  bank                  TEXT,
  initial_balance_cents INTEGER NOT NULL DEFAULT 0,
  notes                 TEXT,
  active                INTEGER NOT NULL DEFAULT 1,
  created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  doc        TEXT,
  phone      TEXT,
  email      TEXT,
  notes      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

CREATE TABLE IF NOT EXISTS purchases (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  number         TEXT NOT NULL UNIQUE,
  supplier_id    INTEGER REFERENCES suppliers(id),
  purchase_date  TEXT NOT NULL,
  items_cents    INTEGER NOT NULL DEFAULT 0,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents    INTEGER NOT NULL DEFAULT 0,
  affects_stock  INTEGER NOT NULL DEFAULT 0,
  kind           TEXT NOT NULL DEFAULT 'investimento'
                 CHECK (kind IN ('investimento','operacional')),
  status         TEXT NOT NULL DEFAULT 'aberta'
                 CHECK (status IN ('aberta','cancelada')),
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_date ON purchases(purchase_date);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);

CREATE TABLE IF NOT EXISTS purchase_items (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id        INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id         INTEGER NOT NULL REFERENCES products(id),
  qty                INTEGER NOT NULL DEFAULT 1,
  unit_price_cents   INTEGER NOT NULL DEFAULT 0,
  discount_cents     INTEGER NOT NULL DEFAULT 0,
  subtotal_cents     INTEGER NOT NULL DEFAULT 0,
  -- quanto deste item ja foi somado ao estoque; a diferenca e o que falta
  stock_applied_qty  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_pitems_purchase ON purchase_items(purchase_id);
CREATE INDEX IF NOT EXISTS idx_pitems_product ON purchase_items(product_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  qty_delta   INTEGER NOT NULL,
  reason      TEXT NOT NULL,
  purchase_id INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  /* origem dano/perda (0023): baixa e estorno apontam para a ocorrencia */
  damage_report_id INTEGER REFERENCES damage_reports(id) ON DELETE SET NULL,
  reservation_id   INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
  notes       TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_stockmov_product ON stock_movements(product_id);
CREATE INDEX IF NOT EXISTS idx_stockmov_purchase ON stock_movements(purchase_id);
CREATE INDEX IF NOT EXISTS idx_stockmov_damage ON stock_movements(damage_report_id);
CREATE INDEX IF NOT EXISTS idx_stockmov_reservation ON stock_movements(reservation_id);

CREATE TABLE IF NOT EXISTS financial_entries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  number             TEXT NOT NULL UNIQUE,
  direction          TEXT NOT NULL CHECK (direction IN ('receber','pagar')),
  origin             TEXT NOT NULL DEFAULT 'outro'
                     CHECK (origin IN ('locacao','frete','compra','despesa','outro')),
  customer_id        INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  supplier_id        INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  reservation_id     INTEGER REFERENCES reservations(id) ON DELETE CASCADE,
  freight_id         INTEGER REFERENCES freights(id) ON DELETE CASCADE,
  purchase_id        INTEGER REFERENCES purchases(id) ON DELETE CASCADE,
  category           TEXT,
  description        TEXT,
  amount_cents       INTEGER NOT NULL,
  due_date           TEXT NOT NULL,
  -- data da compra/competencia (lancamento manual); parcelas de compra leem a
  -- data pela tabela purchases, via purchase_id
  purchase_date      TEXT,
  installment        INTEGER NOT NULL DEFAULT 1,
  installments_total INTEGER NOT NULL DEFAULT 1,
  account_id         INTEGER REFERENCES financial_accounts(id) ON DELETE SET NULL,
  status             TEXT NOT NULL DEFAULT 'aberta'
                     CHECK (status IN ('aberta','quitada','cancelada')),
  notes              TEXT,
  created_by         INTEGER REFERENCES users(id),
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_entries_direction ON financial_entries(direction, status);
CREATE INDEX IF NOT EXISTS idx_entries_due ON financial_entries(due_date);
CREATE INDEX IF NOT EXISTS idx_entries_purchase ON financial_entries(purchase_id);
CREATE INDEX IF NOT EXISTS idx_entries_reservation ON financial_entries(reservation_id);
CREATE INDEX IF NOT EXISTS idx_entries_purchase_date ON financial_entries(purchase_date);

CREATE TABLE IF NOT EXISTS receipts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       TEXT NOT NULL UNIQUE,
  source_type  TEXT NOT NULL CHECK (source_type IN ('payment', 'deposit', 'quitacao')),
  payment_id   INTEGER REFERENCES payments(id) ON DELETE SET NULL,
  deposit_id   INTEGER REFERENCES deposits(id) ON DELETE SET NULL,
  entry_id     INTEGER REFERENCES financial_entries(id) ON DELETE SET NULL,
  amount_cents INTEGER NOT NULL,
  paid_at      TEXT NOT NULL,
  method       TEXT,
  body         TEXT,
  issued_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_by_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  /* assinatura da empresa ja cadastrada no momento da emissao (0021) */
  company_signature_included INTEGER,
  /* quitação (0024): obrigação quitada ('locacao'|'caucao' apontando para a
     reserva) e os lançamentos que compõem o total, congelados em JSON */
  obrigacao_tipo TEXT CHECK (obrigacao_tipo IS NULL OR obrigacao_tipo IN ('locacao','caucao')),
  obrigacao_id   INTEGER,
  payment_ids    TEXT,
  CHECK (
    (source_type = 'payment' AND payment_id IS NOT NULL AND deposit_id IS NULL AND payment_ids IS NULL)
    OR
    (source_type = 'deposit' AND deposit_id IS NOT NULL AND payment_id IS NULL AND payment_ids IS NULL)
    OR
    (source_type = 'quitacao' AND payment_id IS NULL AND deposit_id IS NULL
       AND obrigacao_tipo IS NOT NULL AND obrigacao_id IS NOT NULL AND payment_ids IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_receipts_payment ON receipts(payment_id);
CREATE INDEX IF NOT EXISTS idx_receipts_deposit ON receipts(deposit_id);
CREATE INDEX IF NOT EXISTS idx_receipts_entry ON receipts(entry_id);
CREATE INDEX IF NOT EXISTS idx_receipts_obrigacao ON receipts(obrigacao_tipo, obrigacao_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_payment ON receipts(payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_deposit ON receipts(deposit_id) WHERE deposit_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_quitacao ON receipts(obrigacao_tipo, obrigacao_id) WHERE source_type = 'quitacao';

`;

/** Gera o proximo numero sequencial de um documento (LIMA-001, FRT-001, ...). */
export async function nextNumber(
  table: "reservations" | "quotes" | "freights" | "contracts" | "purchases" | "financial_entries",
  prefix: string,
): Promise<string> {
  const row = await one<{ n: string }>(
    `SELECT number AS n FROM ${table} WHERE number LIKE ? ORDER BY LENGTH(number) DESC, number DESC LIMIT 1`,
    [prefix + "-%"],
  );
  const last = row ? parseInt(row.n.split("-").pop() ?? "0", 10) : 0;
  return `${prefix}-${String(last + 1).padStart(3, "0")}`;
}

/**
 * Gera uma SEQUENCIA de numeros de documentos (parcelamento N parcelas).
 *
 * Uma unica consulta substitui N: antes, cada parcela buscava "o ultimo
 * numero" de novo, e o custo crescia linearmente com a quantidade de
 * parcelas. Mesma regra de formatacao do nextNumber, com todos os valores
 * calculados em memoria a partir da mesma leitura.
 */
export async function nextNumbers(
  table: "reservations" | "quotes" | "freights" | "contracts" | "purchases" | "financial_entries",
  prefix: string,
  quantidade: number,
): Promise<string[]> {
  const n = Math.max(1, Math.floor(quantidade));
  const row = await one<{ n: string }>(
    `SELECT number AS n FROM ${table} WHERE number LIKE ? ORDER BY LENGTH(number) DESC, number DESC LIMIT 1`,
    [prefix + "-%"],
  );
  const last = row ? parseInt(row.n.split("-").pop() ?? "0", 10) : 0;
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(last + i + 1).padStart(3, "0")}`);
}
