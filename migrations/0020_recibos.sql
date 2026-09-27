-- Recibos de lancamentos financeiros (pagamento, adiantamento e caucao).
--
-- Nada aqui toca nos livros existentes: payments, financial_entries e deposits
-- continuam sendo a unica fonte da verdade financeira do sistema. Esta tabela
-- apenas APONTA para os lancamentos de caixa (e para a caucao), guardando um
-- numero proprio e estavel de recibo, o texto legal montado na emissao e quem
-- emitiu. Apagar um pagamento aqui nao apaga o lancamento — e o lancamento
-- continua existindo mesmo sem recibo, como sempre foi.
--
-- A caução é um caso a parte: ela nao entra no caixa por design do sistema
-- (ver auditoria financeira), entao o recibo dela aponta pelo deposit_id, com
-- source_type = 'deposit'. O ON DELETE SET NULL garante que a exclusao do
-- lancamento (reserva excluida) nunca barra nada nem orfa um recibo quebrado —
-- o recibo fica sem alvo e a pagina mostra que o lancamento não existe mais.
--
-- Migration puramente aditiva e idempotente: nenhuma coluna, linha ou regra
-- existente e alterada.

CREATE TABLE IF NOT EXISTS receipts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  number       TEXT NOT NULL UNIQUE,
  source_type  TEXT NOT NULL CHECK (source_type IN ('payment', 'deposit')),
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
  CHECK (
    (source_type = 'payment' AND payment_id IS NOT NULL AND deposit_id IS NULL)
    OR
    (source_type = 'deposit' AND deposit_id IS NOT NULL AND payment_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_receipts_payment ON receipts(payment_id);
CREATE INDEX IF NOT EXISTS idx_receipts_deposit ON receipts(deposit_id);
CREATE INDEX IF NOT EXISTS idx_receipts_entry ON receipts(entry_id);

-- Um lancamento tem no maximo um recibo. E a trava real contra duplicata em
-- emissoes simultaneas: a segunda corrida quebra aqui, le o recibo do primeiro
-- e devolve ele, sem erro para o usuario.
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_payment ON receipts(payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_receipts_deposit ON receipts(deposit_id) WHERE deposit_id IS NOT NULL;
