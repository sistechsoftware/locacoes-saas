-- Hora extra na extensão de retirada.
--
-- Quando o operador AVANÇA o pickup_at de uma reserva/orçamento já gravada, o
-- servidor calcula as horas estendidas e, enquanto a extensão for menor que o
-- limite configurado (extra_hours_until_daily), cobra horas cheias pelo valor
-- da hora extra (extra_hour_price_cents). Acima do limite nada é cobrado
-- automaticamente: é negociação do operador (a UI avisa).
--
-- extension_minutes = minutos realmente estendidos (rastro do combinado);
-- extension_cents   = valor cobrado, gravado como linha própria do total.
--
-- Defaults 0 mantêm toda linha pré-existente intacta: recalcReservation e
-- recalcQuote só passam a somar extension_cents — com 0, o total é o de sempre.
ALTER TABLE reservations ADD COLUMN extension_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN extension_cents INTEGER NOT NULL DEFAULT 0;

ALTER TABLE quotes ADD COLUMN extension_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quotes ADD COLUMN extension_cents INTEGER NOT NULL DEFAULT 0;
