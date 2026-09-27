-- Programa de fidelidade. A configuracao vive na tabela settings, que ja existe
-- e ja tem tela: nao ha razao para uma tabela de programa so para guardar cinco
-- numeros que o administrador edita.
INSERT OR IGNORE INTO settings(key,value) VALUES
 ('fidelity_active','1'),
 ('fidelity_goal','5'),
 ('fidelity_kits','5'),
 ('fidelity_validity_days','0'),
 ('fidelity_accumulate','1'),
 ('fidelity_eligible_status','retirada,finalizada'),
 ('fidelity_min_value_cents','0'),
 ('fidelity_count_free_rental','0'),
 ('fidelity_expiry_reminders','7,3,1'),
 ('fidelity_window_start','08:00'),
 ('fidelity_window_end','20:00'),
 ('fidelity_notify_progress','0'),
 ('fidelity_notify_almost','1'),
 ('fidelity_notify_earned','1'),
 ('fidelity_notify_used','1'),
 ('fidelity_notify_expiring','1'),
 ('fidelity_notify_expired','0'),
 ('fidelity_return_on_cancel','1');

-- Livro-razao da pontuacao. Nunca se apaga uma linha: cancelar uma locacao
-- lanca uma reversao negativa, para o historico continuar contando o que houve.
CREATE TABLE IF NOT EXISTS fidelity_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id    INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('ponto','reversao','ajuste')),
  delta          INTEGER NOT NULL,
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  -- a mesma locacao nao pontua duas vezes, nem e revertida duas vezes
  UNIQUE (reservation_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_fidelity_events_customer ON fidelity_events(customer_id, id);

-- Cada recompensa e um registro proprio, com o retrato da regra do dia em que
-- foi conquistada: mudar a meta de 5 para 10 amanha nao pode mexer nesta linha.
CREATE TABLE IF NOT EXISTS fidelity_rewards (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id         INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'disponivel'
                        CHECK (status IN ('disponivel','usada','expirada','cancelada')),
  kit_quantity        INTEGER NOT NULL,
  rule_goal           INTEGER NOT NULL,
  rule_validity_days  INTEGER NOT NULL DEFAULT 0,
  cycle               INTEGER NOT NULL,
  earned_at           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_on          TEXT,
  used_at             TEXT,
  used_reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
  used_kits           INTEGER,
  used_discount_cents INTEGER,
  used_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  -- uma recompensa por ciclo fechado: e isso que impede recompensa duplicada
  UNIQUE (customer_id, cycle)
);
CREATE INDEX IF NOT EXISTS idx_fidelity_rewards_customer ON fidelity_rewards(customer_id, status);

-- Mensagens preparadas para o cliente. O envio ao cliente hoje e pelo WhatsApp
-- manual, entao o registro guarda o texto e o momento em que foi realmente
-- enviado, e serve de trava contra repetir o mesmo aviso.
CREATE TABLE IF NOT EXISTS fidelity_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  reward_id   INTEGER REFERENCES fidelity_rewards(id) ON DELETE SET NULL,
  event       TEXT NOT NULL,
  channel     TEXT NOT NULL DEFAULT 'whatsapp',
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pendente'
                CHECK (status IN ('pendente','enviada','falhou','dispensada')),
  error       TEXT,
  sent_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  -- a mesma situacao nao vira duas mensagens
  dedupe_key  TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_fidelity_messages ON fidelity_messages(customer_id, status, id);
