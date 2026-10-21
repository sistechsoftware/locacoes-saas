-- Preços por período (Fase 1) — snapshot de cobrança por linha de item.
--
-- pricing_mode  = modalidade RESOLVIDA no momento da gravação (produto > empresa),
--                 congelada por linha, no mesmo espírito do snapshot de componentes
--                 dos kits: mudar a tabela de preços depois não reescreve o passado.
-- period_qty    = períodos cobrados nesta linha. 'fixo' sempre 1 (fórmula atual
--                 qty × unit × 1 − discount = qty × unit − discount, bit a bit);
--                 'diaria' = dias de calendário da janela [entrega, retirada].
--
-- Defaults cobrem inserts antigos e de teste: toda linha pré-existente vira
-- ('fixo', 1) e os totais históricos não mudam um centavo.
ALTER TABLE reservation_items ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'fixo'
  CHECK (pricing_mode IN ('fixo', 'diaria'));
ALTER TABLE reservation_items ADD COLUMN period_qty INTEGER NOT NULL DEFAULT 1
  CHECK (period_qty >= 1);

ALTER TABLE quote_items ADD COLUMN pricing_mode TEXT NOT NULL DEFAULT 'fixo'
  CHECK (pricing_mode IN ('fixo', 'diaria'));
ALTER TABLE quote_items ADD COLUMN period_qty INTEGER NOT NULL DEFAULT 1
  CHECK (period_qty >= 1);
