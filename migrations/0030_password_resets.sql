-- ============================================================================
-- 0030 — ETAPA 5: E-MAIL TRANSACIONAL (recuperação de senha e avisos)
-- ----------------------------------------------------------------------------
-- Tokens de redefinição de senha: o e-mail carrega um token OPACO de alta
-- entropia; o banco guarda só o SHA-256 dele (vazamento do banco não vira
-- takeover de contas). Uso único, expiração em 1 hora e invalidação dos
-- anteriores do mesmo usuário a cada novo pedido.
-- ============================================================================

CREATE TABLE password_resets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_password_resets_user ON password_resets(user_id, used_at);
