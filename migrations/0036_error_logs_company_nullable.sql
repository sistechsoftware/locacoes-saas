-- ----------------------------------------------------------------------------
-- PENDÊNCIA #07 — error_logs.company_id: NOT NULL DEFAULT 1 -> anulável
-- ----------------------------------------------------------------------------
--
-- Problema: a 0027 adicionou `company_id INTEGER NOT NULL DEFAULT 1` e o
-- registrarErro antigo gravava SEM resolver o escopo (fallback era a empresa
-- padrão 1). Resultado: a empresa 1 enxergava erros de TODAS as empresas
-- (vazamento de mensagens entre tenants) e as demais não viam erro algum
-- próprio; as falhas de cron de qualquer empresa caíam todas na empresa 1.
--
-- A escrita foi corrigida em src/lib/error-log.ts (pendência #07): o
-- registrarErro recebe companyId opcional — empresa da SESSÃO em request,
-- empresa do CONTEXTO runWithCompany no cron — e grava NULL quando o erro é
-- verdadeiramente GLOBAL (sem empresa). NULL só é possível com a coluna
-- anulável: é o que esta migration faz.
--
-- Por que recriar a tabela: SQLite não altera restrição de coluna no lugar
-- (não existe ALTER COLUMN NOT NULL). Vale a receita já usada na 0027 para
-- users — tabela nova -> copiar TODAS as linhas (mesmos ids; NADA é apagado)
-- -> dropar -> renomear -> recriar os índices. PRAGMA foreign_key_check no
-- fim, do mesmo jeito da 0027.
--
-- Backfill das linhas legadas (idempotente; só reatribui o que dá para
-- PROVAR pelo próprio dado):
--  1) falha de cron POR EMPRESA guarda a empresa no JSON de context
--     (registrarFalhaDeEmpresa grava {rotina, companyId, empresa}) -> volta
--     para o dono certo. Isso fecha o "erros de cron caem na empresa 1" também
--     no histórico;
--  2) linha em company 1 SEM empresa identificável (sem user_id e sem
--     companyId no context) era DEFAULT puro: vira NULL (global, visível só
--     ao platform_admin) em vez de seguir vazando para a empresa 1;
--  3) user_id órfão (usuário já saiu da base; o backfill da 0033 pula estes
--     por causa do EXISTS) em company 1 -> NULL, mesma lógica: sem dono
--     comprovado, sem tenant.
-- Linhas com dono válido permanecem intactas (a 0033 já as realinhou).

CREATE TABLE error_logs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,          -- unixepoch(), UTC
  source TEXT NOT NULL,                 -- 'onRequestError' | 'api/log-erro' | 'cron'
  kind TEXT NOT NULL,                   -- 'server' | 'client' (client veio do /api/log-erro)
  route TEXT,                           -- rota quando existe
  method TEXT,
  message TEXT NOT NULL,                -- nome do erro + mensagem, sem stack bruta
  digest TEXT,                          -- digest do Next (ligacao com a tela de erro)
  user_id INTEGER,
  user_name TEXT,                       -- congela o nome: o usuario pode sair da base depois
  context TEXT,                         -- JSON: user agent, status, url, extras
  resolved INTEGER NOT NULL DEFAULT 0,  -- 1 = ja tratado pelo operador (sai da contagem)
  company_id INTEGER                    -- NULL = erro global (visivel so ao platform_admin)
);

INSERT INTO error_logs_new (id, created_at, source, kind, route, method, message, digest,
                            user_id, user_name, context, resolved, company_id)
  SELECT id, created_at, source, kind, route, method, message, digest,
         user_id, user_name, context, resolved, company_id
    FROM error_logs;

DROP TABLE error_logs;
ALTER TABLE error_logs_new RENAME TO error_logs;

CREATE INDEX IF NOT EXISTS idx_error_created  ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_kind     ON error_logs(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_errorlogs_company ON error_logs(company_id);

PRAGMA foreign_key_check;

-- ----------------------------------------------------------------------------
-- 1) Cron por empresa: realinha pelo companyId gravado no context
-- ----------------------------------------------------------------------------
UPDATE error_logs
   SET company_id = CAST(json_extract(context, '$.companyId') AS INTEGER)
 WHERE source = 'cron'
   AND user_id IS NULL
   AND company_id = 1
   AND json_valid(context)
   AND json_extract(context, '$.companyId') IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2) Sem empresa comprovada -> global (NULL), nao mais "empresa 1"
-- ----------------------------------------------------------------------------
UPDATE error_logs
   SET company_id = NULL
 WHERE company_id = 1
   AND user_id IS NULL
   AND (context IS NULL
        OR NOT json_valid(context)
        OR json_extract(context, '$.companyId') IS NULL);

-- ----------------------------------------------------------------------------
-- 3) user_id órfão em company 1 -> NULL (sem dono nao ha tenant)
-- ----------------------------------------------------------------------------
UPDATE error_logs
   SET company_id = NULL
 WHERE company_id = 1
   AND user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = error_logs.user_id);
