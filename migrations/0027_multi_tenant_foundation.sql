-- ============================================================================
-- 0027 — FUNDAÇÃO MULTIEMPRESA
-- ----------------------------------------------------------------------------
-- Transforma a base single-tenant em multi-tenant por `company_id`.
--
-- GARANTIAS
--  * Nenhum dado é apagado: o backfill preenche `company_id = 1` em TODAS as
--    linhas existentes; a empresa 1 (Lima's Locações) herda todo o histórico.
--  * A coluna nasce com DEFAULT 1 + backfill: nenhuma linha fica sem empresa.
--  * Rebuilds de tabela (users, settings, stock_revision) usam a receita
--    oficial SQLite (12 passos) com PRAGMA defer_foreign_keys + SAVEPOINT:
--    os ids são preservados e as FKs dos filhos continuam válidas.
--  * Triggers e índices recriados exatamente como eram (com escopo novo).
--  * PRAGMA foreign_key_check no fim: o arquivo só "passa" se o banco ficar
--    íntegro (no D1 a migration roda em transação — qualquer violação aborta).
-- ============================================================================

PRAGMA defer_foreign_keys = true;

-- ----------------------------------------------------------------------------
-- 1) EMPRESAS + TENANT INICIAL
-- ----------------------------------------------------------------------------
CREATE TABLE companies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  legal_name   TEXT,
  document     TEXT,
  email        TEXT,
  phone        TEXT,
  whatsapp     TEXT,
  address      TEXT,
  city         TEXT,
  logo_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- Tenant inicial: toda a base atual da Lima's Locações pertence a esta empresa.
INSERT INTO companies (id, name, active) VALUES (1, 'Lima''s Locações', 1);

-- ----------------------------------------------------------------------------
-- 2) NUMERAÇÃO DE DOCUMENTOS POR EMPRESA
-- ----------------------------------------------------------------------------
-- Os prefixos (LIMA-, FRT-, CTR-, ...) passam a ser configuração da empresa.
-- Os contadores abaixo são a fonte da sequência por (empresa, prefixo); os
-- documentos históricos NÃO são renumerados.
CREATE TABLE doc_number_counters (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  prefix     TEXT NOT NULL,
  next_seq   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (company_id, prefix)
);

INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'LIMA', COALESCE(MAX(CAST(substr(number, 6) AS INTEGER)), 0) + 1
    FROM reservations WHERE number LIKE 'LIMA-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'ORC', COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 0) + 1
    FROM quotes WHERE number LIKE 'ORC-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'FRT', COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 0) + 1
    FROM freights WHERE number LIKE 'FRT-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'CTR', COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 0) + 1
    FROM contracts WHERE number LIKE 'CTR-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'COMP', COALESCE(MAX(CAST(substr(number, 6) AS INTEGER)), 0) + 1
    FROM purchases WHERE number LIKE 'COMP-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'PAG', COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 0) + 1
    FROM financial_entries WHERE number LIKE 'PAG-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'REC', COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 0) + 1
    FROM financial_entries WHERE number LIKE 'REC-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'RCB', COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 0) + 1
    FROM receipts WHERE number LIKE 'RCB-%';

-- ----------------------------------------------------------------------------
-- 3) REVISÃO DE ESTOQUE POR EMPRESA
-- ----------------------------------------------------------------------------
-- Antes: linha única id=1 (CHECK(id=1)) — empresas compartilhariam a revisão.
-- Agora: uma linha por empresa (id = company_id). O `stock_write_guard`
-- continua single-row: é apenas uma bandeira momentânea dentro do batch.
--
-- Os triggers antigos apontam para a tabela que será dropada; PRECISAM sair
-- antes do DROP, senão o ALTER TABLE RENAME reprocessa triggers órfãos e
-- falha (SQLite não descarta triggers de OUTRAS tabelas junto com a tabela).
DROP TRIGGER IF EXISTS stock_revision_reservations_insert;
DROP TRIGGER IF EXISTS stock_revision_reservations_update;
DROP TRIGGER IF EXISTS stock_revision_reservations_delete;
DROP TRIGGER IF EXISTS stock_revision_reservation_items_insert;
DROP TRIGGER IF EXISTS stock_revision_reservation_items_update;
DROP TRIGGER IF EXISTS stock_revision_reservation_items_delete;
DROP TRIGGER IF EXISTS stock_revision_reservation_item_components_insert;
DROP TRIGGER IF EXISTS stock_revision_reservation_item_components_update;
DROP TRIGGER IF EXISTS stock_revision_reservation_item_components_delete;
DROP TRIGGER IF EXISTS stock_revision_products_insert;
DROP TRIGGER IF EXISTS stock_revision_products_update;
DROP TRIGGER IF EXISTS stock_revision_products_delete;
DROP TRIGGER IF EXISTS stock_revision_product_components_insert;
DROP TRIGGER IF EXISTS stock_revision_product_components_update;
DROP TRIGGER IF EXISTS stock_revision_product_components_delete;
DROP TRIGGER IF EXISTS stock_revision_quotes_insert;
DROP TRIGGER IF EXISTS stock_revision_quotes_update;
DROP TRIGGER IF EXISTS stock_revision_quotes_delete;
DROP TRIGGER IF EXISTS stock_revision_quote_items_insert;
DROP TRIGGER IF EXISTS stock_revision_quote_items_update;
DROP TRIGGER IF EXISTS stock_revision_quote_items_delete;
DROP TRIGGER IF EXISTS stock_revision_damage_reports_resolution;
-- Estes três vivem na tabela `settings`, mas escrevem na stock_revision:
DROP TRIGGER IF EXISTS stock_revision_settings_insert;
DROP TRIGGER IF EXISTS stock_revision_settings_update;
DROP TRIGGER IF EXISTS stock_revision_settings_delete;

SAVEPOINT rebuild_stock_revision;
CREATE TABLE stock_revision_new (
  id       INTEGER PRIMARY KEY CHECK (id >= 1),
  revision INTEGER NOT NULL
);
INSERT INTO stock_revision_new (id, revision)
  SELECT 1, revision FROM stock_revision WHERE id = 1;
INSERT OR IGNORE INTO stock_revision_new (id, revision) SELECT id, 0 FROM companies;
DROP TABLE stock_revision;
ALTER TABLE stock_revision_new RENAME TO stock_revision;
PRAGMA foreign_key_check;
RELEASE rebuild_stock_revision;

-- ----------------------------------------------------------------------------
-- 4) SETTINGS POR EMPRESA (company_settings)
-- ----------------------------------------------------------------------------
-- A tabela `settings` era o KV global da instalação. Vira `company_settings`
-- com PK (company_id, key); os valores existentes vão para a empresa 1
-- exatamente como estavam. A tabela antiga é DROPada — os dados continuam
-- preservados em company_settings (empresa 1), apenas o contêiner global
-- some, pois não deve mais receber escrita. Os triggers
-- stock_revision_settings_* já foram removidos na seção 3.
SAVEPOINT rebuild_settings;
CREATE TABLE company_settings (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT,
  PRIMARY KEY (company_id, key)
);
INSERT INTO company_settings (company_id, key, value)
  SELECT 1, key, value FROM settings;
DROP TABLE settings;
PRAGMA foreign_key_check;
RELEASE rebuild_settings;

-- Mudança de configuração invalida a revisão de disponibilidade da empresa.
CREATE TRIGGER stock_revision_company_settings_insert AFTER INSERT ON company_settings
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_company_settings_update AFTER UPDATE ON company_settings
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_company_settings_delete AFTER DELETE ON company_settings
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = OLD.company_id; END;

-- ----------------------------------------------------------------------------
-- 5) COMPANY_ID EM TODAS AS TABELAS DE TENANT
-- ----------------------------------------------------------------------------
-- NOTA SOBRE FK (regra 7 do briefing): o SQLite RECUSA "ADD COLUMN ... DEFAULT
-- 1 REFERENCES companies(id)" (não é possível adicionar coluna com referência
-- e default não-nulo). Reconstruir 50+ tabelas só para a constraint colocaria
-- em risco dados reais por um ganho que a aplicação já dá: TODA escrita usa o
-- company_id do contexto autenticado (nunca do cliente) e o teste de
-- integridade (tests/multi-tenant.test.ts) verifica órfãos. Tabelas criadas do
-- zero nesta migration (companies, users_new, doc_number_counters,
-- company_settings) mantêm a FK declarada.
-- DEFAULT 1: todo INSERT futuro sem company_id explícito cai na empresa 1;
-- nenhum registro novo pode nascer órfão.
ALTER TABLE categories               ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE customers                ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE products                 ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE product_units            ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE product_components       ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reservations             ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reservation_items        ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE reservation_item_components ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE quotes                   ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE quote_items              ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE payments                 ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE deposits                 ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE expenses                 ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE expense_purposes         ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE vehicles                 ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE freights                 ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE operations               ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE checklists               ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE attachments              ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE damage_reports           ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE maintenance              ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE contracts                ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE contract_signatures      ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE customer_documents       ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notifications            ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE audit_logs               ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE financial_accounts       ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE suppliers                ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE purchases                ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE purchase_items           ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE stock_movements          ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE financial_entries        ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE receipts                 ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE files                    ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE portal_sessions          ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE chat_conversations       ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE chat_participants        ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE chat_messages            ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE promotions               ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE promotion_tiers          ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fidelity_events          ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fidelity_rewards         ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE fidelity_messages        ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE activities               ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_events      ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE user_notifications       ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_preferences ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notification_rules       ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE push_subscriptions       ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE push_deliveries          ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE error_logs               ADD COLUMN company_id INTEGER NOT NULL DEFAULT 1;

-- Backfill de segurança: qualquer linha que porventura esteja NULL (não deve
-- existir, pois a coluna tem DEFAULT) fica explicitamente na empresa 1.
UPDATE categories               SET company_id = 1 WHERE company_id IS NULL;
UPDATE customers                SET company_id = 1 WHERE company_id IS NULL;
UPDATE products                 SET company_id = 1 WHERE company_id IS NULL;
UPDATE product_units            SET company_id = 1 WHERE company_id IS NULL;
UPDATE product_components       SET company_id = 1 WHERE company_id IS NULL;
UPDATE reservations             SET company_id = 1 WHERE company_id IS NULL;
UPDATE reservation_items        SET company_id = 1 WHERE company_id IS NULL;
UPDATE reservation_item_components SET company_id = 1 WHERE company_id IS NULL;
UPDATE quotes                   SET company_id = 1 WHERE company_id IS NULL;
UPDATE quote_items              SET company_id = 1 WHERE company_id IS NULL;
UPDATE payments                 SET company_id = 1 WHERE company_id IS NULL;
UPDATE deposits                 SET company_id = 1 WHERE company_id IS NULL;
UPDATE expenses                 SET company_id = 1 WHERE company_id IS NULL;
UPDATE expense_purposes         SET company_id = 1 WHERE company_id IS NULL;
UPDATE vehicles                 SET company_id = 1 WHERE company_id IS NULL;
UPDATE freights                 SET company_id = 1 WHERE company_id IS NULL;
UPDATE operations               SET company_id = 1 WHERE company_id IS NULL;
UPDATE checklists               SET company_id = 1 WHERE company_id IS NULL;
UPDATE attachments              SET company_id = 1 WHERE company_id IS NULL;
UPDATE damage_reports           SET company_id = 1 WHERE company_id IS NULL;
UPDATE maintenance              SET company_id = 1 WHERE company_id IS NULL;
UPDATE contracts                SET company_id = 1 WHERE company_id IS NULL;
UPDATE contract_signatures      SET company_id = 1 WHERE company_id IS NULL;
UPDATE customer_documents       SET company_id = 1 WHERE company_id IS NULL;
UPDATE notifications            SET company_id = 1 WHERE company_id IS NULL;
UPDATE audit_logs               SET company_id = 1 WHERE company_id IS NULL;
UPDATE financial_accounts       SET company_id = 1 WHERE company_id IS NULL;
UPDATE suppliers                SET company_id = 1 WHERE company_id IS NULL;
UPDATE purchases                SET company_id = 1 WHERE company_id IS NULL;
UPDATE purchase_items           SET company_id = 1 WHERE company_id IS NULL;
UPDATE stock_movements          SET company_id = 1 WHERE company_id IS NULL;
UPDATE financial_entries        SET company_id = 1 WHERE company_id IS NULL;
UPDATE receipts                 SET company_id = 1 WHERE company_id IS NULL;
UPDATE files                    SET company_id = 1 WHERE company_id IS NULL;
UPDATE portal_sessions          SET company_id = 1 WHERE company_id IS NULL;
UPDATE chat_conversations       SET company_id = 1 WHERE company_id IS NULL;
UPDATE chat_participants        SET company_id = 1 WHERE company_id IS NULL;
UPDATE chat_messages            SET company_id = 1 WHERE company_id IS NULL;
UPDATE promotions               SET company_id = 1 WHERE company_id IS NULL;
UPDATE promotion_tiers          SET company_id = 1 WHERE company_id IS NULL;
UPDATE fidelity_events          SET company_id = 1 WHERE company_id IS NULL;
UPDATE fidelity_rewards         SET company_id = 1 WHERE company_id IS NULL;
UPDATE fidelity_messages        SET company_id = 1 WHERE company_id IS NULL;
UPDATE activities               SET company_id = 1 WHERE company_id IS NULL;
UPDATE notification_events      SET company_id = 1 WHERE company_id IS NULL;
UPDATE user_notifications       SET company_id = 1 WHERE company_id IS NULL;
UPDATE notification_preferences SET company_id = 1 WHERE company_id IS NULL;
UPDATE notification_rules       SET company_id = 1 WHERE company_id IS NULL;
UPDATE push_subscriptions       SET company_id = 1 WHERE company_id IS NULL;
UPDATE push_deliveries          SET company_id = 1 WHERE company_id IS NULL;
UPDATE error_logs               SET company_id = 1 WHERE company_id IS NULL;

-- ----------------------------------------------------------------------------
-- 6) USUÁRIOS: company_id + PAPÉIS v1
-- ----------------------------------------------------------------------------
-- CHECK antigo ('admin','operador') exige rebuild da tabela. Receita SQLite
-- com FKs deferidas: nova tabela -> copiar (mesmos ids) -> dropar -> renomear.
-- As sessões existentes continuam válidas: o id do usuário não muda.
SAVEPOINT rebuild_users;
CREATE TABLE users_new (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  username      TEXT NOT NULL UNIQUE,
  email         TEXT,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'operacional'
                CHECK (role IN ('owner','admin','operacional','financeiro','viewer')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  avatar_url    TEXT,
  company_id    INTEGER NOT NULL DEFAULT 1 REFERENCES companies(id)
);
INSERT INTO users_new (id, name, username, email, phone, password_hash, role, active, created_at, avatar_url, company_id)
  SELECT id, name, username, email, phone, password_hash, role, active, created_at, avatar_url, 1 FROM users;
DROP TABLE users;
ALTER TABLE users_new RENAME TO users;
PRAGMA foreign_key_check;
RELEASE rebuild_users;

-- Conversão de papéis: o primeiro administrador existente vira `owner`
-- (mesmo poder, novo nome). Os demais `admin` continuam `admin` e os
-- `operador` viram `operacional` — ninguém perde acesso nesta migração.
UPDATE users SET role = 'owner'
 WHERE role = 'admin'
   AND (SELECT COUNT(*) FROM users WHERE role = 'owner') = 0
   AND id = (SELECT MIN(id) FROM users WHERE role = 'admin');

-- ----------------------------------------------------------------------------
-- 7) TRIGGERS DE REVISÃO DE ESTOQUE (recriados com escopo de empresa)
-- ----------------------------------------------------------------------------
-- (os antigos foram dropados na seção 3, antes do rebuild da tabela)

CREATE TRIGGER stock_revision_reservations_insert AFTER INSERT ON reservations
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_reservations_update AFTER UPDATE ON reservations
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_reservations_delete AFTER DELETE ON reservations
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = OLD.company_id; END;
CREATE TRIGGER stock_revision_reservation_items_insert AFTER INSERT ON reservation_items
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_reservation_items_update AFTER UPDATE ON reservation_items
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_reservation_items_delete AFTER DELETE ON reservation_items
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = OLD.company_id; END;
CREATE TRIGGER stock_revision_reservation_item_components_insert AFTER INSERT ON reservation_item_components
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_reservation_item_components_update AFTER UPDATE ON reservation_item_components
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_reservation_item_components_delete AFTER DELETE ON reservation_item_components
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = OLD.company_id; END;
CREATE TRIGGER stock_revision_products_insert AFTER INSERT ON products
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_products_update AFTER UPDATE ON products
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_products_delete AFTER DELETE ON products
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = OLD.company_id; END;
CREATE TRIGGER stock_revision_product_components_insert AFTER INSERT ON product_components
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_product_components_update AFTER UPDATE ON product_components
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_product_components_delete AFTER DELETE ON product_components
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = OLD.company_id; END;
CREATE TRIGGER stock_revision_quotes_insert AFTER INSERT ON quotes
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_quotes_update AFTER UPDATE ON quotes
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_quotes_delete AFTER DELETE ON quotes
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = OLD.company_id; END;
CREATE TRIGGER stock_revision_quote_items_insert AFTER INSERT ON quote_items
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_quote_items_update AFTER UPDATE ON quote_items
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;
CREATE TRIGGER stock_revision_quote_items_delete AFTER DELETE ON quote_items
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = OLD.company_id; END;
CREATE TRIGGER stock_revision_damage_reports_resolution AFTER UPDATE ON damage_reports
WHEN COALESCE(new.resolution_status,'') IS NOT COALESCE(old.resolution_status,'')
BEGIN UPDATE stock_revision SET revision = revision + 1 WHERE id = NEW.company_id; END;

-- ----------------------------------------------------------------------------
-- 8) TRIGGERS DE ATIVIDADES/NOTIFICAÇÕES (recriados; propagam company_id)
-- ----------------------------------------------------------------------------
DROP TRIGGER IF EXISTS activity_0_insert;
DROP TRIGGER IF EXISTS activity_0_update;
DROP TRIGGER IF EXISTS activity_0_delete;
DROP TRIGGER IF EXISTS activity_1_insert;
DROP TRIGGER IF EXISTS activity_1_update;
DROP TRIGGER IF EXISTS activity_1_delete;
DROP TRIGGER IF EXISTS activity_2_insert;
DROP TRIGGER IF EXISTS activity_2_update;
DROP TRIGGER IF EXISTS activity_2_delete;
DROP TRIGGER IF EXISTS activity_3_insert;
DROP TRIGGER IF EXISTS activity_3_update;
DROP TRIGGER IF EXISTS activity_3_delete;
DROP TRIGGER IF EXISTS activity_4_insert;
DROP TRIGGER IF EXISTS activity_4_update;
DROP TRIGGER IF EXISTS activity_4_delete;
DROP TRIGGER IF EXISTS activity_created;
DROP TRIGGER IF EXISTS activity_changed;
DROP TRIGGER IF EXISTS reservation_activity_details;
DROP TRIGGER IF EXISTS freight_activity_details;
DROP TRIGGER IF EXISTS financial_activity_details;

CREATE TRIGGER activity_0_insert AFTER INSERT ON operations BEGIN
 INSERT INTO activities(company_id,source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES (NEW.company_id,'operations',NEW.id,NEW.kind,NEW.kind || ' #' || NEW.id,NEW.scheduled_at,'/operacao/' || NEW.id,CASE NEW.status WHEN 'concluida' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NEW.assignee_id,NEW.reservation_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 assignee_id=excluded.assignee_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.assignee_id IS NOT excluded.assignee_id;
END;
CREATE TRIGGER activity_0_update AFTER UPDATE ON operations
WHEN OLD.kind IS NOT NEW.kind OR OLD.scheduled_at IS NOT NEW.scheduled_at OR OLD.status IS NOT NEW.status OR OLD.assignee_id IS NOT NEW.assignee_id BEGIN
 INSERT INTO activities(company_id,source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES (NEW.company_id,'operations',NEW.id,NEW.kind,NEW.kind || ' #' || NEW.id,NEW.scheduled_at,'/operacao/' || NEW.id,CASE NEW.status WHEN 'concluida' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NEW.assignee_id,NEW.reservation_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,
 assignee_id=excluded.assignee_id,
 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 OR activities.assignee_id IS NOT excluded.assignee_id;
END;
CREATE TRIGGER activity_0_delete BEFORE DELETE ON operations BEGIN
 UPDATE activities SET status='cancelled',revision=revision+1 WHERE source='operations' AND source_id=OLD.id AND kind=OLD.kind;
END;

CREATE TRIGGER activity_1_insert AFTER INSERT ON reservations BEGIN
 INSERT INTO activities(company_id,source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES (NEW.company_id,'reservations',NEW.id,'reserva','Reserva ' || NEW.number,NEW.event_date || 'T' || COALESCE(NULLIF(NEW.event_time,''),'08:00'),'/reservas/' || NEW.id,CASE WHEN NEW.status='cancelada' THEN 'cancelled' WHEN NEW.status IN ('finalizada','retirada') THEN 'completed' ELSE 'pending' END,NULL,NEW.id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,

 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_1_update AFTER UPDATE ON reservations
WHEN OLD.event_date IS NOT NEW.event_date OR OLD.event_time IS NOT NEW.event_time OR OLD.status IS NOT NEW.status OR OLD.number IS NOT NEW.number BEGIN
 INSERT INTO activities(company_id,source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES (NEW.company_id,'reservations',NEW.id,'reserva','Reserva ' || NEW.number,NEW.event_date || 'T' || COALESCE(NULLIF(NEW.event_time,''),'08:00'),'/reservas/' || NEW.id,CASE WHEN NEW.status='cancelada' THEN 'cancelled' WHEN NEW.status IN ('finalizada','retirada') THEN 'completed' ELSE 'pending' END,NULL,NEW.id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,

 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_1_delete BEFORE DELETE ON reservations BEGIN
 UPDATE activities SET status='cancelled',revision=revision+1 WHERE source='reservations' AND source_id=OLD.id AND kind='reserva';
END;

CREATE TRIGGER activity_2_insert AFTER INSERT ON reservations BEGIN
 INSERT INTO activities(company_id,source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES (NEW.company_id,'reservations',NEW.id,'separacao','Separacao da reserva ' || NEW.number,COALESCE(NULLIF(NEW.delivery_at,''),NEW.event_date || 'T08:00'),'/notificacoes/atividades?reserva=' || NEW.id,CASE WHEN NEW.status='cancelada' THEN 'cancelled' WHEN NEW.status IN ('entregue','em_uso','aguardando_retirada','retirada','finalizada') THEN 'completed' ELSE 'pending' END,NULL,NEW.id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,

 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_2_update AFTER UPDATE ON reservations
WHEN OLD.delivery_at IS NOT NEW.delivery_at OR OLD.event_date IS NOT NEW.event_date OR OLD.status IS NOT NEW.status OR OLD.number IS NOT NEW.number BEGIN
 INSERT INTO activities(company_id,source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES (NEW.company_id,'reservations',NEW.id,'separacao','Separacao da reserva ' || NEW.number,COALESCE(NULLIF(NEW.delivery_at,''),NEW.event_date || 'T08:00'),'/notificacoes/atividades?reserva=' || NEW.id,CASE WHEN NEW.status='cancelada' THEN 'cancelled' WHEN NEW.status IN ('entregue','em_uso','aguardando_retirada','retirada','finalizada') THEN 'completed' ELSE 'pending' END,NULL,NEW.id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,

 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_2_delete BEFORE DELETE ON reservations BEGIN
 UPDATE activities SET status='cancelled',revision=revision+1 WHERE source='reservations' AND source_id=OLD.id AND kind='separacao';
END;

CREATE TRIGGER activity_3_insert AFTER INSERT ON freights BEGIN
 INSERT INTO activities(company_id,source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES (NEW.company_id,'freights',NEW.id,'frete','Frete ' || NEW.number,NEW.date || 'T' || COALESCE(NULLIF(NEW.time,''),'08:00'),'/fretes/' || NEW.id,CASE NEW.status WHEN 'concluido' THEN 'completed' WHEN 'cancelado' THEN 'cancelled' ELSE 'pending' END,NULL,NULL)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,

 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_3_update AFTER UPDATE ON freights
WHEN OLD.date IS NOT NEW.date OR OLD.time IS NOT NEW.time OR OLD.status IS NOT NEW.status OR OLD.number IS NOT NEW.number BEGIN
 INSERT INTO activities(company_id,source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES (NEW.company_id,'freights',NEW.id,'frete','Frete ' || NEW.number,NEW.date || 'T' || COALESCE(NULLIF(NEW.time,''),'08:00'),'/fretes/' || NEW.id,CASE NEW.status WHEN 'concluido' THEN 'completed' WHEN 'cancelado' THEN 'cancelled' ELSE 'pending' END,NULL,NULL)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,

 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_3_delete BEFORE DELETE ON freights BEGIN
 UPDATE activities SET status='cancelled',revision=revision+1 WHERE source='freights' AND source_id=OLD.id AND kind='frete';
END;

CREATE TRIGGER activity_4_insert AFTER INSERT ON financial_entries BEGIN
 INSERT INTO activities(company_id,source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES (NEW.company_id,'financial_entries',NEW.id,'financeiro','Vencimento ' || NEW.number,NEW.due_date || 'T08:00','/financeiro?aba=' || NEW.direction || '&de=' || NEW.due_date || '&ate=' || NEW.due_date || '#parcela-' || NEW.id,CASE NEW.status WHEN 'quitada' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NULL,NEW.reservation_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,

 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_4_update AFTER UPDATE ON financial_entries
WHEN OLD.due_date IS NOT NEW.due_date OR OLD.status IS NOT NEW.status OR OLD.number IS NOT NEW.number BEGIN
 INSERT INTO activities(company_id,source,source_id,kind,title,scheduled_at,link,status,assignee_id,reservation_id) VALUES (NEW.company_id,'financial_entries',NEW.id,'financeiro','Vencimento ' || NEW.number,NEW.due_date || 'T08:00','/financeiro?aba=' || NEW.direction || '&de=' || NEW.due_date || '&ate=' || NEW.due_date || '#parcela-' || NEW.id,CASE NEW.status WHEN 'quitada' THEN 'completed' WHEN 'cancelada' THEN 'cancelled' ELSE 'pending' END,NULL,NEW.reservation_id)
 ON CONFLICT(source,source_id,kind) DO UPDATE SET
 title=excluded.title,scheduled_at=excluded.scheduled_at,link=excluded.link,status=excluded.status,

 revision=activities.revision+1
 WHERE activities.title<>excluded.title OR activities.scheduled_at<>excluded.scheduled_at OR activities.status<>excluded.status
 ;
END;
CREATE TRIGGER activity_4_delete BEFORE DELETE ON financial_entries BEGIN
 UPDATE activities SET status='cancelled',revision=revision+1 WHERE source='financial_entries' AND source_id=OLD.id AND kind='financeiro';
END;

CREATE TRIGGER activity_created AFTER INSERT ON activities BEGIN
 INSERT OR IGNORE INTO notification_events(company_id,activity_id,revision,type) VALUES (NEW.company_id,NEW.id,NEW.revision,'created');
END;
CREATE TRIGGER activity_changed AFTER UPDATE OF revision ON activities WHEN NEW.revision<>OLD.revision BEGIN
 UPDATE push_deliveries SET status='cancelled' WHERE status IN ('pending','sending') AND notification_id IN
 (SELECT n.id FROM user_notifications n JOIN notification_events e ON e.id=n.event_id WHERE e.activity_id=NEW.id AND e.revision<>NEW.revision);
 INSERT OR IGNORE INTO notification_events(company_id,activity_id,revision,type) VALUES
 (NEW.company_id,NEW.id,NEW.revision,CASE WHEN NEW.status='cancelled' THEN 'cancelamento' ELSE 'alteracao' END);
END;

CREATE TRIGGER reservation_activity_details AFTER UPDATE OF address,district,city,total_cents ON reservations
WHEN OLD.address IS NOT NEW.address OR OLD.district IS NOT NEW.district OR OLD.city IS NOT NEW.city OR OLD.total_cents<>NEW.total_cents BEGIN
 UPDATE activities SET revision=revision+1 WHERE reservation_id=NEW.id;
END;
CREATE TRIGGER freight_activity_details AFTER UPDATE OF origin,destination,cargo,amount_cents ON freights
WHEN OLD.origin IS NOT NEW.origin OR OLD.destination IS NOT NEW.destination OR OLD.cargo IS NOT NEW.cargo OR OLD.amount_cents<>NEW.amount_cents BEGIN
 UPDATE activities SET revision=revision+1 WHERE source='freights' AND source_id=NEW.id;
END;
CREATE TRIGGER financial_activity_details AFTER UPDATE OF amount_cents ON financial_entries
WHEN OLD.amount_cents<>NEW.amount_cents BEGIN
 UPDATE activities SET revision=revision+1 WHERE source='financial_entries' AND source_id=NEW.id;
END;

-- ----------------------------------------------------------------------------
-- 9) ÍNDICES MULTIEMPRESA
-- ----------------------------------------------------------------------------
-- Índices de consulta existentes são mantidos (continuam úteis dentro da
-- empresa). Aqui entram os índices por empresa, incluindo as combinações
-- usadas pelas telas mais acessadas (agenda/operacao, financeiro, disponibilidade).
DROP INDEX IF EXISTS idx_expense_purposes_nome;
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_purposes_nome
  ON expense_purposes(company_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_customers_company        ON customers(company_id);
CREATE INDEX IF NOT EXISTS idx_categories_company       ON categories(company_id);
CREATE INDEX IF NOT EXISTS idx_products_company         ON products(company_id);
CREATE INDEX IF NOT EXISTS idx_units_company            ON product_units(company_id);
CREATE INDEX IF NOT EXISTS idx_reservations_company     ON reservations(company_id);
CREATE INDEX IF NOT EXISTS idx_reservations_company_date ON reservations(company_id, event_date);
CREATE INDEX IF NOT EXISTS idx_ritems_company           ON reservation_items(company_id);
CREATE INDEX IF NOT EXISTS idx_ricomp_company           ON reservation_item_components(company_id);
CREATE INDEX IF NOT EXISTS idx_quotes_company           ON quotes(company_id);
CREATE INDEX IF NOT EXISTS idx_qitems_company           ON quote_items(company_id);
CREATE INDEX IF NOT EXISTS idx_payments_company         ON payments(company_id);
CREATE INDEX IF NOT EXISTS idx_deposits_company         ON deposits(company_id);
CREATE INDEX IF NOT EXISTS idx_expenses_company         ON expenses(company_id);
CREATE INDEX IF NOT EXISTS idx_purposes_company         ON expense_purposes(company_id);
CREATE INDEX IF NOT EXISTS idx_vehicles_company         ON vehicles(company_id);
CREATE INDEX IF NOT EXISTS idx_freights_company         ON freights(company_id);
CREATE INDEX IF NOT EXISTS idx_operations_company       ON operations(company_id);
CREATE INDEX IF NOT EXISTS idx_operations_company_sched ON operations(company_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_checklists_company       ON checklists(company_id);
CREATE INDEX IF NOT EXISTS idx_attachments_company      ON attachments(company_id);
CREATE INDEX IF NOT EXISTS idx_damages_company          ON damage_reports(company_id);
CREATE INDEX IF NOT EXISTS idx_maintenance_company      ON maintenance(company_id);
CREATE INDEX IF NOT EXISTS idx_contracts_company        ON contracts(company_id);
CREATE INDEX IF NOT EXISTS idx_contractsigs_company     ON contract_signatures(company_id);
CREATE INDEX IF NOT EXISTS idx_custdocuments_company    ON customer_documents(company_id);
CREATE INDEX IF NOT EXISTS idx_notifications_company    ON notifications(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_company            ON audit_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_finaccounts_company      ON financial_accounts(company_id);
CREATE INDEX IF NOT EXISTS idx_suppliers_company        ON suppliers(company_id);
CREATE INDEX IF NOT EXISTS idx_purchases_company        ON purchases(company_id);
CREATE INDEX IF NOT EXISTS idx_pitems_company           ON purchase_items(company_id);
CREATE INDEX IF NOT EXISTS idx_stockmov_company         ON stock_movements(company_id);
CREATE INDEX IF NOT EXISTS idx_entries_company          ON financial_entries(company_id);
CREATE INDEX IF NOT EXISTS idx_entries_company_due      ON financial_entries(company_id, due_date);
CREATE INDEX IF NOT EXISTS idx_receipts_company         ON receipts(company_id);
CREATE INDEX IF NOT EXISTS idx_files_company            ON files(company_id);
CREATE INDEX IF NOT EXISTS idx_portalsessions_company   ON portal_sessions(company_id);
CREATE INDEX IF NOT EXISTS idx_chatconv_company         ON chat_conversations(company_id);
CREATE INDEX IF NOT EXISTS idx_chatpart_company         ON chat_participants(company_id);
CREATE INDEX IF NOT EXISTS idx_chatmsg_company          ON chat_messages(company_id);
CREATE INDEX IF NOT EXISTS idx_promotions_company       ON promotions(company_id);
CREATE INDEX IF NOT EXISTS idx_promotiers_company       ON promotion_tiers(company_id);
CREATE INDEX IF NOT EXISTS idx_fidevents_company        ON fidelity_events(company_id);
CREATE INDEX IF NOT EXISTS idx_fidrewards_company       ON fidelity_rewards(company_id);
CREATE INDEX IF NOT EXISTS idx_fidmessages_company      ON fidelity_messages(company_id);
CREATE INDEX IF NOT EXISTS idx_activities_company       ON activities(company_id);
CREATE INDEX IF NOT EXISTS idx_notifevents_company      ON notification_events(company_id);
CREATE INDEX IF NOT EXISTS idx_usernotif_company        ON user_notifications(company_id);
CREATE INDEX IF NOT EXISTS idx_notifpref_company        ON notification_preferences(company_id);
CREATE INDEX IF NOT EXISTS idx_notifrules_company       ON notification_rules(company_id);
CREATE INDEX IF NOT EXISTS idx_pushsubs_company         ON push_subscriptions(company_id);
CREATE INDEX IF NOT EXISTS idx_pushdeliv_company        ON push_deliveries(company_id);
CREATE INDEX IF NOT EXISTS idx_errorlogs_company        ON error_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_users_company            ON users(company_id);

-- ----------------------------------------------------------------------------
-- 10) VERIFICAÇÃO FINAL DE INTEGRIDADE
-- ----------------------------------------------------------------------------
-- No D1 (migration roda em transação) qualquer violação de FK pendente aborta
-- a migration inteira — nada é aplicado pela metade. Os testes automatizados
-- (tests/multi-tenant.test.ts) validam também contagens antes/depois.
PRAGMA foreign_key_check;
