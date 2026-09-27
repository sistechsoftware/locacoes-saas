-- Diario de erros do servidor.
--
-- O Workers manda console.error para os logs do Cloudflare, mas nao sobra
-- nada pesquisavel dentro do proprio sistema: quem opera a aplicacao nao
-- consegue ver O QUE quebrou nem QUANDO. Esta tabela guarda cada erro de
-- servidor com contexto minimo (rota, metodo, usuario) para diagnostico.
--
-- Poda: o cron diario apaga o que passou de 30 dias (veja src/lib/error-log.ts).
CREATE TABLE IF NOT EXISTS error_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,          -- unixepoch(), UTC
  source TEXT NOT NULL,                 -- 'onRequestError' | 'api/log-erro' | 'cron'
  kind TEXT NOT NULL,                   -- 'server' | 'client' (client veio do /api/log-erro)
  route TEXT,                           -- x-nextjs-route quando existe
  method TEXT,
  message TEXT NOT NULL,                -- nome do erro + mensagem, sem stack bruta
  digest TEXT,                          -- digest do Next (ligacao com a tela de erro)
  user_id INTEGER,
  user_name TEXT,                       -- congela o nome: o usuario pode sair da base depois
  context TEXT,                         -- JSON: user agent, status, url, extras
  resolved INTEGER NOT NULL DEFAULT 0   -- 1 = ja tratado pelo operador (sai da contagem)
);

CREATE INDEX IF NOT EXISTS idx_error_created ON error_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_kind ON error_logs(kind, created_at DESC);
