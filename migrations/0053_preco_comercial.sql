-- Preço comercial aplicado por linha (migração 0053).
--
-- PROBLEMA: unit_price_cents já era gravado, mas nada registrava DE ONDE ele
-- veio. Sem essa origem, tanto o editor quanto as actions de edição não sabiam
-- distinguir "preço automático da promoção" de "preço negociado com o cliente"
-- e reaplicavam a promoção vigente toda vez que o registro era reaberto e
-- salvo — trocando silenciosamente o valor acordado.
--
-- A partir daqui cada linha carrega:
--   price_source            = origem do preço aplicado: 'normal' (catálogo),
--                             'promocao' (regra de promoção) ou 'manual'
--                             (negociação do operador). NULL = linha anterior a
--                             esta migração, origem DESCONHECIDA — é tratada
--                             como preservada e nunca recalculada (não se
--                             inventa dado histórico).
--   base_price_cents        = preço de catálogo do produto no momento da venda.
--   promo_unit_price_cents  = preço unitário que a promoção dava naquele momento
--                             (auditoria: mostra o desconto mesmo quando o
--                             operador aplicou um valor manual por cima).
--   promotion_id            = promoção aplicada, quando existir. Sem FK de
--                             propósito: apagar uma promoção não pode apagar nem
--                             travar o histórico financeiro de uma locação.
--
-- O valor efetivamente cobrado continua sendo unit_price_cents (nenhuma coluna
-- redundante). Linhas antigas nascem com NULL em tudo: preço e totais
-- históricos permanecem exatamente iguais.
ALTER TABLE reservation_items ADD COLUMN price_source TEXT
  CHECK (price_source IS NULL OR price_source IN ('normal', 'promocao', 'manual'));
ALTER TABLE reservation_items ADD COLUMN base_price_cents INTEGER;
ALTER TABLE reservation_items ADD COLUMN promo_unit_price_cents INTEGER;
ALTER TABLE reservation_items ADD COLUMN promotion_id INTEGER;

ALTER TABLE quote_items ADD COLUMN price_source TEXT
  CHECK (price_source IS NULL OR price_source IN ('normal', 'promocao', 'manual'));
ALTER TABLE quote_items ADD COLUMN base_price_cents INTEGER;
ALTER TABLE quote_items ADD COLUMN promo_unit_price_cents INTEGER;
ALTER TABLE quote_items ADD COLUMN promotion_id INTEGER;
