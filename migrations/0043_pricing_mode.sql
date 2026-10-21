-- Preços por período (Fase 1) — modalidade de cobrança do produto.
--
-- Decide o que a linha do item quer dizer com o unit_price_cents:
--   'fixo'   = preço por unidade (o sistema atual, 100% do comportamento de hoje)
--   'diaria' = preço por diária, multiplicado pela duração da janela
--   NULL     = segue o default da empresa (pricing_default_mode) — a precedência
--              aprovada na auditoria é produto > default da empresa > nada.
--              Por isso a coluna é anulável: 'NOT NULL DEFAULT fixo' mataria o
--              default da empresa para sempre (todo produto já nasceria explícito).
--
-- Linhas antigas nascem NULL e resolvem para 'fixo' enquanto a empresa não
-- mudar o default — comportamento idêntico ao de hoje.
ALTER TABLE products ADD COLUMN pricing_mode TEXT
  CHECK (pricing_mode IS NULL OR pricing_mode IN ('fixo', 'diaria'));
