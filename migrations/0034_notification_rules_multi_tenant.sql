-- ============================================================================
-- 0034 — NOTIFICATION_RULES POR EMPRESA (Pendência #04)
-- ----------------------------------------------------------------------------
-- O que quebrava: a tabela nasceu na 0006 com `type TEXT PRIMARY KEY`, uma
-- linha por tipo NO BANCO INTEIRO. A 0027 apenas adicionou company_id DEFAULT
-- 1, entao:
--   * so existiam regras da empresa 1 -> a tela de preferencias de qualquer
--     outra empresa mostrava ZERO regras;
--   * o cron faz LEFT JOIN notification_rules r ON r.company_id=n.company_id
--     -> NULL -> !!rule_enabled = false -> push 'cancelled';
--   * era IMPOSSIVEL inserir a regra de uma segunda empresa (PK unica em
--     'type' recusaria a linha).
--
-- O que esta migration faz (aditiva, sem apagar nada):
--   1) rebuild da tabela com a chave (company_id, type) — as linhas existentes
--      sao copiadas byte a byte (empresa 1 mantem enabled/offsets/message que
--      ja havia personalizado);
--   2) indice UNIQUE explicito (company_id, type) + indice de empresa;
--   3) backfill das 12 regras padrao (0006 = 10 tipos, 0010 = aniversario,
--      0014 = chat) para TODA empresa que ainda nao tem a linha, com
--      INSERT OR IGNORE — rodar duas vezes nao muda nada e nunca sobrescreve
--      configuracao existente;
--   4) alinha notification_events.company_id pela atividade dona (mesma
--      filosofia do backfill 0033, que nao cobriu esta tabela).
--
-- Seguindo o padrao da 0027: sem SAVEPOINT/transacao explicita (o D1 remoto
-- rejeita erro 7000/7500) — cada migration e um lote atomico proprio, e sem
-- FK para companies (a tabela nao tinha FK antes; adicionar agora quebraria
-- `DELETE FROM companies` usado pelos testes de onboarding).
-- ============================================================================

PRAGMA defer_foreign_keys = true;

-- ----------------------------------------------------------------------------
-- 1) REBUILD: a chave passa a ser (company_id, type)
-- ----------------------------------------------------------------------------
-- Restos de uma tentativa interrompida (se alguma ferramenta rodar o arquivo
-- fora da transação da migration) não podem travar a reexecução.
DROP TABLE IF EXISTS notification_rules_multi;

CREATE TABLE notification_rules_multi (
  company_id INTEGER NOT NULL DEFAULT 1,
  type       TEXT    NOT NULL,
  enabled    INTEGER NOT NULL DEFAULT 1,
  offsets    TEXT    NOT NULL DEFAULT '[60,0]',
  message    TEXT    NOT NULL DEFAULT '',
  PRIMARY KEY (company_id, type)
);

-- Copia integral: nenhuma linha e reescrita, nenhum valor e "corrigido".
INSERT INTO notification_rules_multi (company_id, type, enabled, offsets, message)
  SELECT company_id, type, enabled, offsets, message FROM notification_rules;

DROP TABLE notification_rules;
ALTER TABLE notification_rules_multi RENAME TO notification_rules;

-- ----------------------------------------------------------------------------
-- 2) INDICES: UNIQUE (company_id, type) explicita + indice de empresa
-- ----------------------------------------------------------------------------
-- O PK acima ja garante a unicidade; o indice nomeado deixa a intencao
-- visivel/verificavel (PRAGMA index_list) e atende qualquer leitura por
-- (company_id, type) sem varrer a tabela.
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_rules_company_type
  ON notification_rules (company_id, type);
-- Recriado: someu junto com o DROP da tabela antiga (existia desde a 0027).
CREATE INDEX IF NOT EXISTS idx_notifrules_company
  ON notification_rules (company_id);

-- ----------------------------------------------------------------------------
-- 3) BACKFILL: as 12 regras padrao para cada empresa
-- ----------------------------------------------------------------------------
-- Valores EXATAMENTE os das migrations originais:
--   0006 -> 10 tipos com enabled=1, offsets='[60,0]', message=''
--   0010 -> 'aniversario'   enabled=1, offsets='[]'   (sem lembrete)
--   0014 -> 'chat'          enabled=1, offsets='[0]'  (aviso imediato)
-- INSERT OR IGNORE: linha ja existente (inclusive as da empresa 1, que podem
-- ter offsets/mensagem personalizados) permanece intacta.
--
-- POR QUE VALUES E NAO UNION ALL: o D1 remoto limita SQLITE_LIMIT_COMPOUND_SELECT
-- a 5 termos (medido em 06/10/2026 em limas-saas-staging-db: 5 termos passam,
-- 6 ja falham). O UNION ALL de 12 tipos morria com "too many terms in compound
-- SELECT: SQLITE_ERROR [code: 7500]" e derrubava a migration inteira (rollback
-- verificado: nenhuma linha aplicada, schema antigo intacto). A CTE com VALUES
-- entrega a mesma lista sem compound SELECT e roda igual no SQLite local dos
-- testes (limite 500).
WITH regras (type, enabled, offsets, message) AS (
  VALUES ('entrega',      1, '[60,0]', '')
       , ('retirada',     1, '[60,0]', '')
       , ('montagem',     1, '[60,0]', '')
       , ('desmontagem',  1, '[60,0]', '')
       , ('separacao',    1, '[60,0]', '')
       , ('reserva',      1, '[60,0]', '')
       , ('frete',        1, '[60,0]', '')
       , ('financeiro',   1, '[60,0]', '')
       , ('alteracao',    1, '[60,0]', '')
       , ('cancelamento', 1, '[60,0]', '')
       , ('aniversario',  1, '[]',     '')
       , ('chat',         1, '[0]',    '')
)
INSERT OR IGNORE INTO notification_rules (company_id, type, enabled, offsets, message)
SELECT c.id, r.type, r.enabled, r.offsets, r.message
FROM companies c
CROSS JOIN regras r;

-- ----------------------------------------------------------------------------
-- 4) BACKFILL: notification_events alinhado pela atividade dona
-- ----------------------------------------------------------------------------
-- Eventos gravados antes da 0032 carregavam o DEFAULT 1 mesmo pertencendo a
-- outra empresa. A atividade e a fonte de verdade do tenant (e e por ela que
-- o agendador escopa o processamento). Idempotente: linha certa e no-op.
UPDATE notification_events
   SET company_id = (SELECT a.company_id FROM activities a WHERE a.id = notification_events.activity_id)
 WHERE EXISTS (SELECT 1 FROM activities a
                WHERE a.id = notification_events.activity_id
                  AND a.company_id <> notification_events.company_id);

PRAGMA foreign_key_check;
