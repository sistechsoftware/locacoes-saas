-- ============================================================================
-- 0029 — ETAPA 3: CAMADA COMERCIAL DO SAAS (planos, assinatura, cobrança)
-- ----------------------------------------------------------------------------
-- Fundação de billing sobre a fundação multiempresa (0027/0028). Regras:
--  * NADA aqui altera dados de tenant existentes — apenas cria estruturas
--    novas de plataforma e popula o catálogo de planos;
--  * Asaas é o provedor de cobrança (API v3). Os ids dele ficam em colunas
--    próprias; sem Asaas configurado o sistema segue funcionando (trial e
--    bloqueio locais);
--  * toda tabela de assinatura pertence a UMA empresa (company_id UNIQUE em
--    subscriptions: uma empresa tem no máximo uma assinatura).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) PLANOS (catálogo da plataforma, sem company_id)
-- ----------------------------------------------------------------------------
CREATE TABLE plans (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  price_cents  INTEGER NOT NULL,
  max_users    INTEGER NOT NULL DEFAULT 3,
  trial_days   INTEGER NOT NULL DEFAULT 14,
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

INSERT INTO plans (slug, name, description, price_cents, max_users, trial_days, sort_order) VALUES
  ('essencial',    'Essencial',    'Para operações pequenas: reservas, clientes, estoque e financeiro.',   7990,  3, 14, 1),
  ('profissional', 'Profissional', 'Para equipes em crescimento: mais usuários, portal, chat e relatórios.', 14990, 10, 14, 2),
  ('empresarial',  'Empresarial',  'Operação completa: multiusuário, fidelidade, fretes e suporte prioritário.', 24990, 30, 14, 3);

-- ----------------------------------------------------------------------------
-- 2) ASSINATURA POR EMPRESA (uma linha por empresa)
-- ----------------------------------------------------------------------------
-- status: trial | active | past_due | suspended | canceled
--   trial      -> periodo de avaliação (trial_ends_at);
--   active     -> paga e dentro do periodo (current_period_end);
--   past_due   -> cobrança vencida, ainda em tolerância (aviso, sem bloqueio);
--   suspended  -> bloqueada por inadimplência/decisão da plataforma;
--   canceled   -> cancelada pela empresa ou plataforma.
CREATE TABLE subscriptions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  plan_id             INTEGER NOT NULL REFERENCES plans(id),
  status              TEXT NOT NULL DEFAULT 'trial'
                      CHECK (status IN ('trial','active','past_due','suspended','canceled')),
  trial_ends_at       TEXT,
  current_period_start TEXT,
  current_period_end  TEXT,
  payment_method      TEXT CHECK (payment_method IN ('PIX','CREDIT_CARD','BOLETO') OR payment_method IS NULL),
  asaas_customer_id   TEXT,
  asaas_subscription_id TEXT,
  suspended_at        TEXT,
  canceled_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_subscriptions_status ON subscriptions(status, current_period_end);

-- ----------------------------------------------------------------------------
-- 3) COBRANÇAS GERADAS (espelho dos payments do Asaas)
-- ----------------------------------------------------------------------------
-- status segue a nomenclatura do Asaas (PENDING/RECEIVED/CONFIRMED/OVERDUE/
-- REFUNDED/CANCELED), normalizado em minúsculas aqui.
CREATE TABLE subscription_payments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subscription_id     INTEGER NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  asaas_payment_id    TEXT UNIQUE,
  amount_cents        INTEGER NOT NULL,
  billing_type        TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','received','confirmed','overdue','refunded','canceled')),
  due_date            TEXT,
  paid_at             TEXT,
  period_start        TEXT,
  period_end          TEXT,
  invoice_url         TEXT,
  invoice_number      TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_subpayments_company ON subscription_payments(company_id, status, due_date);
CREATE INDEX idx_subpayments_status  ON subscription_payments(status, due_date);

-- ----------------------------------------------------------------------------
-- 4) WEBHOOKS DO ASAAS (auditoria + idempotência)
-- ----------------------------------------------------------------------------
-- payload_hash = SHA-256 do corpo bruto: o Asaas pode reenviar o mesmo evento
-- e o UNIQUE abaixo garante processamento único.
CREATE TABLE webhook_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event       TEXT NOT NULL,
  payload     TEXT NOT NULL,
  payload_hash TEXT NOT NULL UNIQUE,
  handled     INTEGER NOT NULL DEFAULT 0,
  handled_at  TEXT,
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ----------------------------------------------------------------------------
-- 5) ADMINISTRADOR DA PLATAFORMA (super-admin do SaaS)
-- ----------------------------------------------------------------------------
-- 0 = usuário comum de uma empresa; 1 = operador do SaaS, acessa /saas.
-- O primeiro usuário criado pelo /setup de uma instalação nova nasce como
-- platform_admin para que a plataforma tenha quem opere o painel.
ALTER TABLE users ADD COLUMN platform_admin INTEGER NOT NULL DEFAULT 0;
