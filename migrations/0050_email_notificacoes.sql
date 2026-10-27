-- ============================================================================
-- 0050 — E-MAILS TRANSCIONAIS POR EMPRESA (fila + histórico + idempotência)
-- ----------------------------------------------------------------------------
-- O que já existe e é reaproveitado (NADA disto é recriado):
--   * notification_rules (0034)  -> antecedências em minutos POR EMPRESA, hoje
--     usadas pelo push interno da equipe. Continua intocada: o e-mail ao CLIENTE
--     é outro público e outro canal, com configuração própria;
--   * company_settings (0027)    -> configuração por empresa (chaves email_* da
--     whitelist de src/lib/settings.ts). Nenhuma tabela nova para configuração;
--   * fidelity_messages (0008)   -> já guarda o aviso de fidelidade com
--     dedupe_key única; o e-mail nasce do MESMO evento, nunca de contagem nova;
--   * activities/notification_events (0006) -> lembretes internos de equipe;
--   * cron a cada minuto (custom-worker.ts) + paraCadaEmpresa -> agendamento.
--
-- O que esta migration cria: UMA tabela que faz as três funções pedidas —
-- intenção de notificação, fila com retry e histórico auditável. Não há tabela
-- de configuração (usa company_settings) nem tabela de "envios" separada da
-- fila: um mesmo registro transita de pendente a enviado/falha, e é isso que
-- permite reprocessar sem perder o histórico.
--
-- idempotência: dedupe_key UNIQUE é a trava. A chave é montada pelo código com
-- prefixo de empresa (c{id}:...) + identidade ESTÁVEL do evento (reserva,
-- operação, ciclo de fidelidade, offset do lembrete, dia). Reexecutar o cron,
-- rodar dois isolates ao mesmo tempo ou repetir a mesma transição de status
-- não cria a segunda linha: o INSERT simplesmente não acontece.
--
-- Segurança multi-tenant: company_id NOT NULL + índice (company_id, ...). Toda
-- leitura/escrita filtra por company_id; a origem do evento é a autoridade do
-- tenant (reserva/operacao/cliente), nunca a sessão de quem acionou o cron.
--
-- Padrões da casa (0027/0034): aditiva, sem SAVEPOINT, sem FK para companies
-- (mantém DELETE FROM companies dos testes de onboarding), lote atômico.
-- FKs para o dono do evento usam ON DELETE SET NULL: apagar a reserva não pode
-- apagar o HISTÓRICO de o que foi de fato enviado.
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_notifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL DEFAULT 1,
  -- tipo do aviso (chave estável de src/lib/email-notificacoes.ts)
  type           TEXT    NOT NULL,
  -- origem do disparo: reserva | operacao | fidelidade | configuracao
  source         TEXT    NOT NULL,
  source_id      INTEGER,
  reservation_id INTEGER REFERENCES reservations(id) ON DELETE SET NULL,
  customer_id    INTEGER REFERENCES customers(id)    ON DELETE SET NULL,
  -- contexto mínimo (JSON) para renderizar NO ENVIO: só identificadores.
  -- o conteúdo volta do banco na hora do envio, então dados alterados depois
  -- do agendamento nunca são reenviados em versão antiga.
  context        TEXT    NOT NULL DEFAULT '{}',
  recipient      TEXT    NOT NULL DEFAULT '',
  subject        TEXT    NOT NULL DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'pendente'
                 CHECK (status IN ('pendente','enviando','enviado','falha_temporaria','falha_definitiva','cancelado','ignorado')),
  -- motivo resumido quando NÃO foi enviado (config desabilitada, sem e-mail,
  -- inconsistência de tenant, falha). Nunca guarda conteúdo sensível.
  motivo         TEXT,
  -- unix seconds: quando o envio pode acontecer (lembrete = horário alvo)
  scheduled_at   INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  next_attempt   INTEGER NOT NULL DEFAULT 0,
  -- lease de processamento: recupera claims de isolate que morreu no meio
  lease_until    INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  -- id devolvido pelo provedor (Resend) — aceitação, não caixa postal
  provider_id    TEXT,
  sent_at        INTEGER,
  created_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch()),
  dedupe_key     TEXT    NOT NULL UNIQUE
);

-- fila: o cron procura vencidos por (status, next_attempt)
CREATE INDEX IF NOT EXISTS idx_email_notifications_queue
  ON email_notifications (status, next_attempt);
-- histórico por empresa (tela de notificações)
CREATE INDEX IF NOT EXISTS idx_email_notifications_company
  ON email_notifications (company_id, id DESC);
-- cancelamento/reativação por registro de origem (reserva/operacao)
CREATE INDEX IF NOT EXISTS idx_email_notifications_source
  ON email_notifications (company_id, source, source_id);
-- lembretes pendentes de uma reserva específica
CREATE INDEX IF NOT EXISTS idx_email_notifications_reservation
  ON email_notifications (company_id, reservation_id);
