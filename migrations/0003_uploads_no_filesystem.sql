-- Armazenamento de imagens no banco.
--
-- O Worker do Cloudflare nao tem sistema de arquivos, entao gravar em
-- public/uploads falha em producao. As imagens passam a viver no D1 e sao
-- servidas por /api/arquivo/<id>.
CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BLOB NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
