-- Desconto com expressão R$ ou % (migração 0046).
--
-- O campo de desconto (geral e por item) ganha seletor R$ | %. O valor
-- cobrado continua sendo discount_cents (nada muda na conta); discount_expr
-- guarda a FORMA escolhida pelo operador ("10%", "12,5%" ou NULL = R$) para
-- o formulário reabrir no modo certo e as telas exibirem "10% (R$ 150,00)".
-- NULL em toda linha antiga = comportamento idêntico ao de antes.
ALTER TABLE reservations ADD COLUMN discount_expr TEXT;
ALTER TABLE quotes ADD COLUMN discount_expr TEXT;
ALTER TABLE reservation_items ADD COLUMN discount_expr TEXT;
ALTER TABLE quote_items ADD COLUMN discount_expr TEXT;
