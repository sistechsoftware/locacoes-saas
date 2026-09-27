-- Adiantamento de reserva. Nao e uma entidade nova: reaproveita
-- financial_entries (previsto) e payments (realizado), os mesmos livros do
-- parcelamento que ja existe. A unica coisa que falta neles e onde guardar a
-- forma de pagamento combinada para um recebimento que ainda nao aconteceu.
ALTER TABLE financial_entries ADD COLUMN expected_method TEXT;
