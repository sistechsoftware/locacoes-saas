-- Aniversariantes. Tudo aditivo: nenhuma coluna existente muda, nenhum dado e
-- reescrito, e cliente antigo sem data continua funcionando igual.
ALTER TABLE customers ADD COLUMN birth_date TEXT;

-- A busca e sempre por dia e mes, nunca pelo ano. O indice sobre a expressao e
-- o que mantem a consulta barata quando a base de clientes crescer.
CREATE INDEX IF NOT EXISTS idx_customers_birth_md
  ON customers(substr(birth_date, 6, 5)) WHERE birth_date IS NOT NULL;

-- Trava de aviso repetido na caixa que ja existe. A coluna e opcional e o
-- indice ignora nulos, entao todo aviso ja gravado continua valido.
ALTER TABLE user_notifications ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_notifications_dedupe
  ON user_notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Entra como mais um tipo da central de notificacoes, com o mesmo interruptor
-- que os outros tipos ja tem.
INSERT OR IGNORE INTO notification_rules(type, enabled, offsets, message)
VALUES ('aniversario', 1, '[]', '');

INSERT OR IGNORE INTO settings(key,value) VALUES
 ('birthday_active','1'),
 ('birthday_days_ahead','7'),
 ('birthday_notify_today','1'),
 ('birthday_notify_upcoming','1'),
 ('birthday_push','1'),
 ('birthday_hour','8');
