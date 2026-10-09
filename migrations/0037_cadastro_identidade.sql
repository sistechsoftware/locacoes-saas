-- 0037 — Cadastro com tipo de pessoa (PF/PJ) + CPF/CNPJ, login por identificador.
--
-- users ganha duas colunas NOVAS:
--   * person_type — 'pf' | 'pj', escolhido no cadastro;
--   * document    — CPF (11) ou CNPJ (14), SOMENTE dígitos, único em TODAS as
--                   contas (o login é global, como users.username — o lookup por
--                   identificador precisa ser inequívoco entre empresas).
--
-- Contas antigas ficam com NULL nas duas colunas: a migração NÃO supõe tipo nem
-- documento de ninguém, não apaga nada e não recria conta. A conclusão do
-- cadastro acontece depois do login (Configurações -> Minha conta), sem bloquear
-- o acesso legítimo. Nenhuma coluna existente é alterada ou removida.
--
-- Índice de unicidade PARCIAL (só linhas preenchidas): nasce aplicável mesmo com
-- a base inteira legada (document IS NULL em todas as linhas), então a migração
-- roda sem varrer dados e sem falhar por duplicata histórica. Corridas entre
-- cadastros simultâneos são barradas pelo índice, não só pela checagem da
-- aplicação.

ALTER TABLE users ADD COLUMN person_type TEXT
  CHECK (person_type IS NULL OR person_type IN ('pf', 'pj'));

ALTER TABLE users ADD COLUMN document TEXT
  CHECK (document IS NULL OR length(document) IN (11, 14));

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_document ON users (document)
  WHERE document IS NOT NULL;

-- Busca por e-mail no login/recuperação: lower(email) é a forma consultada.
-- Índice de expressão (sem unicidade — e-mails legados podem duplicar; a
-- ambiguidade é tratada na aplicação, que recusa o login em vez de escolher
-- uma conta ao acaso).
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email))
  WHERE email IS NOT NULL AND email <> '';
