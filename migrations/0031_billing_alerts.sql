-- ============================================================================
-- 0031 — ETAPA 5: LOG DE AVISOS COMERCIAIS (deduplicação de e-mails)
-- ----------------------------------------------------------------------------
-- A tabela notifications e RECONSTRUÍDA pela varredura de alertas operacionais
-- (notifications.ts apaga dedupe_keys fora do conjunto atual), então não serve
-- de memória para os avisos do billing. Aqui fica o registro imutável do que
-- já foi enviado: a chave UNIQUE decide o envio único.
--   * trial-expirando:<subId>:<fim>  -> 1 aviso por janela de trial;
--   * trial-expirado:<subId>:<fim>   -> 1 aviso por trial expirado (uma nova
--     reativação de trial gera chave nova, e avisa de novo).
-- ============================================================================

CREATE TABLE billing_alerts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  chave      TEXT NOT NULL UNIQUE,
  sent_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_billing_alerts_company ON billing_alerts(company_id, sent_at);
