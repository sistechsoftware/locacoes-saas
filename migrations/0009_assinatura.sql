-- Assinatura virtual de contratos e historico documental do cliente.
-- Os contratos existentes nao sao tocados: quem nao tem assinatura digital
-- simplesmente continua como esta.
INSERT OR IGNORE INTO settings(key,value) VALUES ('signature_link_days','7');

CREATE TABLE IF NOT EXISTS contract_signatures (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id       INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
  customer_id       INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  reservation_id    INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
  -- guardamos so o hash: quem tiver acesso ao banco nao consegue reconstruir o
  -- link e abrir o contrato de um cliente
  token_hash        TEXT NOT NULL UNIQUE,
  version           INTEGER NOT NULL DEFAULT 1,
  status            TEXT NOT NULL DEFAULT 'pendente'
                      CHECK (status IN ('pendente','assinado','revogado')),
  -- congelado no momento da assinatura: editar o contrato depois nao altera
  -- o que a pessoa leu e aceitou
  body_snapshot     TEXT,
  signer_name       TEXT,
  signature_file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
  document_hash     TEXT,
  accepted_at       TEXT,
  signed_at         TEXT,
  ip_address        TEXT,
  user_agent        TEXT,
  expires_at        TEXT,
  revoked_at        TEXT,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_contract_signatures ON contract_signatures(contract_id, status);
CREATE INDEX IF NOT EXISTS idx_contract_signatures_customer ON contract_signatures(customer_id, id);

-- Historico documental: cada documento e um registro proprio e nenhum
-- substitui o anterior, porque um cliente acumula contratos ao longo do tempo.
CREATE TABLE IF NOT EXISTS customer_documents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id    INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  contract_id    INTEGER REFERENCES contracts(id) ON DELETE SET NULL,
  reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
  signature_id   INTEGER REFERENCES contract_signatures(id) ON DELETE SET NULL,
  title          TEXT NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('assinatura_virtual','upload_manual')),
  file_id        TEXT REFERENCES files(id) ON DELETE SET NULL,
  mime           TEXT,
  size           INTEGER,
  notes          TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_customer_documents ON customer_documents(customer_id, id);
