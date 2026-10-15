-- ============================================================================
-- 0041 — MÓDULO DE SUPORTE (chamados da empresa <-> equipe da plataforma)
-- ----------------------------------------------------------------------------
-- Produto (relatório de implementação do suporte):
--  * ABERTURA e acompanhamento são FUNDAMENTAIS — todo plano (Essencial,
--    Profissional e Empresarial) abre e responde chamados: o canal de
--    atendimento não é item da oferta, e o próprio planos.ts proíbe inventar
--    limitação comercial fora dela;
--  * "suporte prioritário" (recurso já registrado na matriz, minimo =
--    empresarial) é o NÍVEL DE FILA: a prioridade é CALCULADA em runtime pela
--    matriz (recursoLiberado(company, 'suporte')) — nunca um `if (plano ==
--    ...)` gravado em banco. As colunas priority/plano_abertura guardam apenas
--    o CONTEXTO DA ABERTURA (histórico e exibição), e a fila reordena pelo
--    estado atual (troca de plano/cortesia surte efeito imediato);
--  * company_id nas DUAS tabelas: escopo de tenant lido da sessão no servidor,
--    nunca de parâmetro do navegador (guarda estática da pendência #04 — todo
--    INSERT em src/ precisa declarar company_id);
--  * anexos usam a tabela files existente (mesmo caminho do chat), com rota
--    própria /api/suporte/arquivo/<id> que confere vínculo com o chamado.
--
-- Notificação: o novo tipo 'suporte' entra na fila de push existente. Sem a
-- linha em notification_rules o cron cancela a entrega (LEFT JOIN ->
-- rule_enabled NULL), entao esta migration semeia a regra PADRAO para TODA
-- empresa existente — mesma semântica do backfill da 0034 (INSERT OR IGNORE,
-- nunca reescreve preferência pessoal). Empresas novas nascem com a regra via
-- REGRAS_PADRAO (src/lib/push-rules.ts), que o onboarding já aplica.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) CHAMADOS — um chamado pertence a UMA empresa e nasce aberto
-- ----------------------------------------------------------------------------
-- status:
--   aberto             -> aberto pela empresa, ainda não visto pelo suporte
--   em_andamento       -> há movimento (resposta da plataforma ou da empresa)
--   aguardando_empresa -> plataforma respondeu e aguarda a empresa
--   resolvido          -> fechado (empresa ou plataforma); reabre para 'aberto'
-- priority: contexto da abertura (a prioridade AO VIVO sai da matriz em TS)
CREATE TABLE IF NOT EXISTS support_tickets (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by         INTEGER NOT NULL REFERENCES users(id),
  category           TEXT NOT NULL CHECK (category IN ('erro','cobranca','duvida','sugestao')),
  subject            TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'aberto'
                     CHECK (status IN ('aberto','em_andamento','aguardando_empresa','resolvido')),
  priority           TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','prioritario')),
  plano_abertura     TEXT,
  context            TEXT,
  first_response_at  TEXT,
  resolved_at        TEXT,
  -- Cursor de "não lidas" por lado (mesmo desenho do chat: id da última
  -- mensagem vista — comparar timestamps perderia mensagem no mesmo segundo)
  empresa_last_seen_id    INTEGER,
  plataforma_last_seen_id INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_support_tickets_company ON support_tickets(company_id, updated_at DESC);
CREATE INDEX idx_support_tickets_status  ON support_tickets(status, created_at);

-- ----------------------------------------------------------------------------
-- 2) MENSAGENS — conversa do chamado (autor = usuário da empresa ou a
--    plataforma; company_id acompanha o CHAMADO, não o autor — o operador da
--    plataforma não tem empresa dona do chamado)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS support_messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  author_id   INTEGER REFERENCES users(id),
  author_kind TEXT NOT NULL CHECK (author_kind IN ('empresa','suporte')),
  body        TEXT NOT NULL,
  file_id     TEXT REFERENCES files(id) ON DELETE SET NULL,
  file_name   TEXT,
  file_mime   TEXT,
  file_size   INTEGER,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_support_msg_ticket ON support_messages(ticket_id, id);

-- ----------------------------------------------------------------------------
-- 3) REGRA DE NOTIFICAÇÃO DO NOVO TIPO (push + tela de preferências)
-- ----------------------------------------------------------------------------
INSERT OR IGNORE INTO notification_rules (company_id, type, enabled, offsets, message)
SELECT id, 'suporte', 1, '[0]', '' FROM companies;
