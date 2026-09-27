-- Lançamento manual de contas a pagar.
--
-- Até aqui, toda conta a pagar nascia de uma compra: a tela de Compras gravava
-- a data da compra em `purchases.purchase_date` e gerava as parcelas em
-- `financial_entries` apenas com a data de vencimento. Com o lançamento manual
-- a própria parcela passa a poder carregar as duas datas — a competência
-- (quando a despesa aconteceu, ex.: compra no cartão) e o vencimento (quando
-- o dinheiro deve sair, ex.: fechamento da fatura).
--
-- Coluna opcional: nenhuma linha existente muda. As parcelas geradas por
-- compra continuam lendo a data da compra pela tabela `purchases` (JOIN em
-- purchase_id), como sempre fizeram, e as antigas ficam com NULL aqui.
ALTER TABLE financial_entries ADD COLUMN purchase_date TEXT;

CREATE INDEX IF NOT EXISTS idx_entries_purchase_date ON financial_entries(purchase_date);
