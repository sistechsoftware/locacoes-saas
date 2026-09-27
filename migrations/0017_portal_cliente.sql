-- Portal do Cliente.
--
-- O portal reutiliza todo o resto do sistema: fidelidade (fidelity_events,
-- fidelity_rewards, regraAtual/painelDoCliente), reservas, pagamentos,
-- contratos, contract_signatures e customer_documents. Nenhuma tabela dessas
-- muda. O que falta e so a CREDENCIAL do cliente — como ele entra no portal —
-- e a sessao propria, que precisa ser independente da sessao do funcionario:
-- um cookie de cliente nunca pode abrir a area interna, e vice-versa.
--
-- Tudo aqui e aditivo: ALTER TABLE ... ADD COLUMN nao toca em linha nenhuma,
-- clientes sem portal continuam com NULL e o sistema atual segue igual.

ALTER TABLE customers ADD COLUMN portal_password_hash TEXT;
ALTER TABLE customers ADD COLUMN portal_setup_token_hash TEXT;
ALTER TABLE customers ADD COLUMN portal_setup_expires_at TEXT;

CREATE TABLE IF NOT EXISTS portal_sessions (
  id         TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_customer ON portal_sessions(customer_id);
CREATE INDEX IF NOT EXISTS idx_portal_sessions_expires ON portal_sessions(expires_at);

-- Ajustes do portal, no mesmo formato KV da tabela settings que as demais
-- configuracoes do sistema ja usam.
INSERT OR IGNORE INTO settings(key,value) VALUES
 ('portal_public_notice',''),
 ('portal_whatsapp',''),
 ('portal_contact_phone',''),
 ('portal_contact_email','');
