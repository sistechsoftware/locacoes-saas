-- ----------------------------------------------------------------------------
-- 0052 — EXCLUSÃO E ESTORNO DE PAGAMENTOS/ADIANTAMENTOS
--
-- Duas correções estruturais, nenhuma linha financeira é alterada:
--
-- 1) RECEIPTS: a trava que impedia apagar um lançamento.
--
--    A 0020/0024 declararam payment_id/deposit_id com ON DELETE SET NULL, mas
--    o CHECK da mesma tabela exige que um recibo 'payment' tenha payment_id
--    NOT NULL (idem 'deposit'). Em SQLite, o SET NULL disparado pela exclusão
--    do pagamento viola esse CHECK e a exclusão inteira falha com
--    "CHECK constraint failed: receipts". Efeito real em produção: a opção
--    "Remover" de um pagamento/adiantamento que já tinha recibo emitido
--    quebrava a operação (HTTP 500), e excluir uma reserva com recibos
--    também. O recibo é só um COMPROVANTE: nunca pode impedir que o
--    lançamento seja corrigido.
--
--    A tabela é reconstruída (SQLite não altera CHECK) mantendo o CHECK de
--    exclusividade entre as fontes, agora SEM exigir o alvo presente: um
--    recibo pode ficar órfão (payment_id/deposit_id NULL) quando o lançamento
--    é excluído — estado que o comentário original da 0020 já previa e para o
--    qual a página do recibo tem tratamento.
--
-- 2) PAYMENTS: vínculo entre o estorno e o recebimento original.
--
--    refund_of_payment_id aponta para o lançamento estornado. É o que permite
--    (a) bloquear estorno duplicado no próprio banco, por índice UNIQUE
--    parcial, e (b) exibir o histórico como par entrada/saída. O estorno em
--    si continua sendo uma linha NEGATIVA no mesmo livro de caixa
--    (payments), como a transferência já faz — nada de tabela paralela.
--
-- Idempotente por construção: a cópia de receipts parte da tabela renomeada e
-- a coluna nova nasce depois (migração roda uma única vez pelo wrangler).
-- ----------------------------------------------------------------------------

DROP TABLE IF EXISTS receipts_old_estorno;

ALTER TABLE receipts RENAME TO receipts_old_estorno;

-- Os índices acompanham a tabela renomeada; sem dropar, os nomes colidem na
-- recriação (mesmo procedimento da 0024).
DROP INDEX IF EXISTS idx_receipts_payment;
DROP INDEX IF EXISTS idx_receipts_deposit;
DROP INDEX IF EXISTS idx_receipts_entry;
DROP INDEX IF EXISTS idx_receipts_obrigacao;
DROP INDEX IF EXISTS idx_receipts_company;
DROP INDEX IF EXISTS uq_receipts_payment;
DROP INDEX IF EXISTS uq_receipts_deposit;
DROP INDEX IF EXISTS uq_receipts_quitacao;

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
  company_id   INTEGER NOT NULL DEFAULT 1,
  company_signature_included INTEGER,
  obrigacao_tipo TEXT CHECK (obrigacao_tipo IS NULL OR obrigacao_tipo IN ('locacao','caucao')),
  obrigacao_id   INTEGER,
  payment_ids    TEXT,
  /* Um recibo pertence a UMA fonte. O alvo pode ficar NULL quando o
     lançamento é excluído (ON DELETE SET NULL) — o comprovante não pode
     bloquear a correção do caixa. */
  CHECK (
    (source_type = 'payment' AND deposit_id IS NULL AND payment_ids IS NULL)
    OR
    (source_type = 'deposit' AND payment_id IS NULL AND payment_ids IS NULL)
    OR
    (source_type = 'quitacao' AND payment_id IS NULL AND deposit_id IS NULL
       AND obrigacao_tipo IS NOT NULL AND obrigacao_id IS NOT NULL AND payment_ids IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_receipts_payment ON receipts(payment_id);
CREATE INDEX IF NOT EXISTS idx_receipts_deposit ON receipts(deposit_id);
CREATE INDEX IF NOT EXISTS idx_receipts_entry ON receipts(entry_id);
CREATE INDEX IF NOT EXISTS idx_receipts_obrigacao ON receipts(obrigacao_tipo, obrigacao_id);
CREATE INDEX IF NOT EXISTS idx_receipts_company ON receipts(company_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_payment ON receipts(payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_deposit ON receipts(deposit_id) WHERE deposit_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_quitacao
  ON receipts(obrigacao_tipo, obrigacao_id) WHERE source_type = 'quitacao';

INSERT INTO receipts
  (id, number, source_type, payment_id, deposit_id, entry_id, amount_cents, paid_at,
   method, body, issued_by, issued_by_name, created_at, company_id,
   company_signature_included, obrigacao_tipo, obrigacao_id, payment_ids)
SELECT
  id, number, source_type, payment_id, deposit_id, entry_id, amount_cents, paid_at,
  method, body, issued_by, issued_by_name, created_at, company_id,
  company_signature_included, obrigacao_tipo, obrigacao_id, payment_ids
FROM receipts_old_estorno;

DROP TABLE receipts_old_estorno;

-- Elo do estorno com o recebimento original. NULL = lançamento comum.
ALTER TABLE payments
  ADD COLUMN refund_of_payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL;

-- Um recebimento só pode ser estornado UMA vez. A trava é o banco: duas
-- requisições simultâneas (clique duplo, retry) esbarram no índice e o lote
-- inteiro é revertido — nenhum estorno duplicado chega a existir.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payments_estorno_unico
  ON payments(refund_of_payment_id)
  WHERE refund_of_payment_id IS NOT NULL;
