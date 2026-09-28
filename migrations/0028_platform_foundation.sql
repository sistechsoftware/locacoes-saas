-- ============================================================================
-- 0028 — ESTRUTURA DE PLATAFORMA (sem cobrança)
-- ----------------------------------------------------------------------------
-- Preparação mínima para o SaaS comercial (Asaas/planos/trial vêm DEPOIS,
-- em etapas próprias). Nada aqui toca em linha existente:
--  * audit_logs ganha company_id/ip/user_agent (logs de plataforma ficam com
--    company_id NULL);
--  * prefixos de numeração por empresa (a sequência em si vive na tabela
--    doc_number_counters, migration 0027);
--  * limpeza de buckets antigos do rate limit (tabela global de plataforma).
-- ============================================================================

-- Auditoria: escopo da empresa + rastreabilidade de rede.
-- company_id NULL = log de plataforma (futuro painel administrativo do SaaS).
ALTER TABLE audit_logs ADD COLUMN company_id_ref INTEGER REFERENCES companies(id);
ALTER TABLE audit_logs ADD COLUMN ip TEXT;
ALTER TABLE audit_logs ADD COLUMN user_agent TEXT;

-- Preenche o escopo pelo usuário do log (fonte: users.company_id, migration 0027).
UPDATE audit_logs SET company_id_ref =
  (SELECT u.company_id FROM users u WHERE u.id = audit_logs.user_id)
 WHERE company_id_ref IS NULL;

CREATE INDEX IF NOT EXISTS idx_audit_company_ref ON audit_logs(company_id_ref, created_at);

-- Prefixo de numeração por empresa. Empresa 1 herda o prefixo histórico
-- LIMA (reservas): documentos existentes continuam válidos e a sequência
-- nova (doc_number_counters) segue a partir do último número usado.
--
-- Correção da migration 0027: o backfill de numeração herda o prefixo real
-- de cada série existente (não apenas LIMA), e por isso o contador é
-- recalculado aqui com o comprimento correto do prefixo.
DELETE FROM doc_number_counters WHERE company_id = 1;
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'LIMA', COALESCE(MAX(CAST(substr(number, 6) AS INTEGER)), 0) + 1 FROM reservations WHERE number LIKE 'LIMA-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'ORC', COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 0) + 1 FROM quotes WHERE number LIKE 'ORC-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'FRT', COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 0) + 1 FROM freights WHERE number LIKE 'FRT-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'CTR', COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 0) + 1 FROM contracts WHERE number LIKE 'CTR-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'COMP', COALESCE(MAX(CAST(substr(number, 6) AS INTEGER)), 0) + 1 FROM purchases WHERE number LIKE 'COMP-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'PAG', COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 0) + 1 FROM financial_entries WHERE number LIKE 'PAG-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'REC', COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 0) + 1 FROM financial_entries WHERE number LIKE 'REC-%';
INSERT INTO doc_number_counters (company_id, prefix, next_seq)
  SELECT 1, 'RCB', COALESCE(MAX(CAST(substr(number, 5) AS INTEGER)), 0) + 1 FROM receipts WHERE number LIKE 'RCB-%';
INSERT INTO company_settings (company_id, key, value)
  SELECT 1, 'doc_prefix_reservations', 'LIMA'
   WHERE NOT EXISTS (SELECT 1 FROM company_settings WHERE company_id = 1 AND key = 'doc_prefix_reservations');
INSERT INTO company_settings (company_id, key, value)
  SELECT id, 'doc_prefix_reservations', 'LOC' FROM companies WHERE id <> 1
   AND NOT EXISTS (SELECT 1 FROM company_settings WHERE company_id = companies.id AND key = 'doc_prefix_reservations');

-- Tokens de sessão antigos não sobrevivem a trocas estruturais de papel:
-- a política de produção (a definir no painel) decide o TTL. Aqui apenas
-- garantimos que a tabela de rate limit (plataforma) não cresça sem poda:
DELETE FROM api_rate_limits WHERE expires_at < CAST(strftime('%s','now') AS INTEGER);
