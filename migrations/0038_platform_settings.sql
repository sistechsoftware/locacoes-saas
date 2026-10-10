-- ============================================================================
-- 0038 — CONFIGURAÇÕES DA PLATAFORMA (painel /saas)
-- ----------------------------------------------------------------------------
-- O painel /saas precisa de um lugar para cadastrar as credenciais do Asaas
-- (token de API, ambiente e token de webhook) sem exigir terminal. Antes só
-- existiam secrets do Worker, e o painel apenas MOSTRAVA o estado.
--
-- Regras:
--   * Escopo da PLATAFORMA, não de empresa — por isso sem company_id (o canto
--     administrativo nunca recebe dado de tenant; ver nota no saas/layout).
--   * Valor pode ser SEGREDO (asaas_api_key, asaas_webhook_token). Estes são
--     gravados CIFRADOS (AES-GCM, prefixo enc:v1:) com a chave PAINEL_CHAVE
--     (secret do Worker). Sem essa chave a gravação de segredo é RECUSADA —
--     ver src/lib/platform-settings.ts. Valores não-sensíveis (ambiente)
--     ficam em claro.
--   * Prioridade na leitura: secret do Worker vence; o painel é o fallback.
--     Nada do que já funciona hoje muda comportamento.
-- ============================================================================

CREATE TABLE platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
