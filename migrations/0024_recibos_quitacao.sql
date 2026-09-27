-- Recibo unificado de quitação.
--
-- Continua a migration 0020 (recibos) sem alterar NENHUM dado: a tabela
-- receipts passa a admitir o recibo do tipo 'quitacao' — um documento
-- ADICIONAL que nasce quando a obrigação de uma reserva (locação ou caução)
-- é quitada integralmente. Os recibos individuais continuam existindo e
-- continuam apontando para os lançamentos exatamente como sempre apontaram.
--
-- Novas colunas:
--   obrigacao_tipo / obrigacao_id  -> a obrigação quitada: 'locacao' com o id
--     da reserva, ou 'caucao' com o id da reserva (a caução é da reserva, não
--     de uma linha de deposits — assim várias cauções recebidas da mesma
--     reserva compõem UMA quitação).
--   payment_ids -> os lançamentos que compõem o total quitado, congelados
--     em JSON na emissão (evidência do comprovante; nunca fonte da verdade).
--
-- A quitação de cada obrigação é única: o índice parcial
-- uq_receipts_quitacao barra a duplicata no banco, então nem duas emissões
-- simultâneas nem rotinas reexecutadas geram um segundo documento.
--
-- SQLite não faz ALTER COLUMN: a tabela é reconstruída no padrão do sistema
-- (renomear -> criar nova -> copiar linha a linha -> dropar a antiga).
-- Idempotente: se uma execução anterior morreu no meio, a cópia recomeça do
-- zero sem perder nada — a tabela antiga só some depois da cópia completa.

DROP TABLE IF EXISTS receipts_old_quitacao;

ALTER TABLE receipts RENAME TO receipts_old_quitacao;

-- Ao renomear a tabela, os índices que a referenciavam (idx_receipts_* e as
-- uq_receipts_*) continuam existindo, mas agora apontam para a tabela velha;
-- se sobrarem no momento da recriação, bloqueiam a UNIQUE nova. Em produção
-- sobrevivem todos (a 0020/0021 criaram os quatro); em teste o estado pode
-- variar — dropar explicitamente é o seguro.
DROP INDEX IF EXISTS idx_receipts_payment;
DROP INDEX IF EXISTS idx_receipts_deposit;
DROP INDEX IF EXISTS idx_receipts_entry;
DROP INDEX IF EXISTS uq_receipts_payment;
DROP INDEX IF EXISTS uq_receipts_deposit;

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
  /* assinatura da empresa já cadastrada no momento da emissão (0021) */
  company_signature_included INTEGER,
  /* quitação (0024): obrigação quitada e os lançamentos que a compõem */
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

-- Um lançamento tem no máximo um recibo (0020, preservado).
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_payment ON receipts(payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_deposit ON receipts(deposit_id) WHERE deposit_id IS NOT NULL;
-- Uma obrigação tem no máximo UM recibo de quitação: a trava final contra
-- duplicata, mesmo com duas emissões simultâneas ou rotinas reexecutadas.
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_quitacao
  ON receipts(obrigacao_tipo, obrigacao_id) WHERE source_type = 'quitacao';

-- Cópia fiel: cada recibo existente segue com o mesmo id, número, texto,
-- flag de assinatura e vínculo de lançamento que tinha antes.
INSERT INTO receipts
  (id, number, source_type, payment_id, deposit_id, entry_id, amount_cents, paid_at,
   method, body, issued_by, issued_by_name, created_at, company_signature_included,
   obrigacao_tipo, obrigacao_id, payment_ids)
SELECT
  id, number, source_type, payment_id, deposit_id, entry_id, amount_cents, paid_at,
  method, body, issued_by, issued_by_name, created_at, company_signature_included,
  NULL, NULL, NULL
FROM receipts_old_quitacao;

DROP TABLE receipts_old_quitacao;
