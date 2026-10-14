-- ============================================================================
-- 0039 — GESTÃO AVANÇADA DE PLANOS: PERSONALIZAÇÃO POR EMPRESA E CORTESIAS
-- ----------------------------------------------------------------------------
-- Regras:
--  * NADA aqui altera dados de tenant existentes — apenas cria estruturas
--    novas. Uma empresa sem personalização continua com exatamente o mesmo
--    comportamento de antes (a precedência resolve pelo plano contratado);
--  * a assinatura, as cobranças e o catálogo de planos NÃO mudam: liberação
--    excepcional e cortesia são camadas por cima, não troca de plano;
--  * o registro de auditoria continua sendo o audit_logs existente (quem,
--    quando, antes/depois) — nenhuma tabela nova de log.
--  * datas de cortesia são gravadas no FUSO DO NEGÓCIO (America/Sao_Paulo),
--    no formato ISO local 'YYYY-MM-DDTHH:MM' — o mesmo do nowLocal(), o que
--    permite comparar lexigraficamente sem conversão ( Worker roda em UTC).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) AJUSTES INDIVIDUAIS DE FUNCIONALIDADE (liberar/bloquear excepcionalmente)
-- ----------------------------------------------------------------------------
-- Uma linha por (empresa, funcionalidade): effect='allow' libera além do plano;
-- effect='block' excepciona uma funcionalidade que o plano inclui. Remover a
-- linha devolve a regra padrão do plano ('auto'). A precedência (block >
-- fundamental > allow > plano > cortesia) é aplicada em src/lib/planos.ts.
CREATE TABLE company_feature_overrides (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature        TEXT NOT NULL,                      -- slug do recurso em planos.ts
  effect         TEXT NOT NULL CHECK (effect IN ('allow','block')),
  reason         TEXT,                               -- motivo informado pelo operador
  created_by     INTEGER REFERENCES users(id),       -- platform_admin responsável
  created_by_name TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
-- UNIQUE garante idempotência: repetir a mesma liberação não duplica linha.
CREATE UNIQUE INDEX idx_cfo_company_feature ON company_feature_overrides(company_id, feature);

-- ----------------------------------------------------------------------------
-- 2) CORTESIAS (plano de referência cedido por período determinado)
-- ----------------------------------------------------------------------------
-- A cortesia NÃO toca na assinatura comercial: é um registro independente com
-- vigência própria. O benefício vale enquanto starts_at <= agora <= ends_at e
-- a cortesia não foi cancelada — o estado é DERIVADO do tempo no momento do
-- acesso (nunca depende de cron). As colunas *_registrado_em existem só para a
-- rotina diária registrar início/término no audit_logs uma única vez.
-- Renovação = nova linha (o histórico anterior é preservado, nunca sobrescrito).
CREATE TABLE company_courtesies (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plan_slug          TEXT NOT NULL,                  -- plano-referência dos benefícios
  starts_at          TEXT NOT NULL,                  -- 'YYYY-MM-DDTHH:MM' (fuso do negócio)
  ends_at            TEXT NOT NULL,
  reason             TEXT NOT NULL,                  -- motivo da concessão (obrigatório)
  notes              TEXT,                           -- observações administrativas
  canceled_at        TEXT,                           -- cancelamento antecipado
  canceled_by        INTEGER REFERENCES users(id),
  canceled_by_name   TEXT,
  created_by         INTEGER REFERENCES users(id),   -- platform_admin responsável
  created_by_name    TEXT,
  inicio_registrado_em TEXT,                         -- marcador da rotina diária
  fim_registrado_em    TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_cortesia_company ON company_courtesies(company_id, ends_at);

-- ----------------------------------------------------------------------------
-- 3) AJUSTE INDIVIDUAL DE LIMITE DE USUÁRIOS (opcional e explícito)
-- ----------------------------------------------------------------------------
-- Os limites comerciais (3/10/30) continuam vindo do plano por padrão; esta
-- tabela só entra quando o operador da plataforma ajusta UM empresa de forma
-- explícita e auditada. A ausência da linha = comportamento original exato.
CREATE TABLE company_limit_overrides (
  company_id     INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  max_users      INTEGER NOT NULL,
  reason         TEXT,
  created_by     INTEGER REFERENCES users(id),
  created_by_name TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
