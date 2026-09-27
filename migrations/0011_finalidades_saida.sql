-- Finalidades de saida configuraveis pelo administrador.
--
-- expenses.category continua sendo TEXT livre, sem chave estrangeira: e isso
-- que garante que desativar ou renomear uma finalidade nunca altere um
-- lancamento ja registrado. O catalogo diz o que aparece para escolher; o
-- historico guarda o que foi escolhido no dia.
CREATE TABLE IF NOT EXISTS expense_purposes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- "Combustivel" e "combustivel" seriam a mesma coisa para quem usa, entao o
-- banco recusa as duas antes que a tela precise se preocupar com isso.
CREATE UNIQUE INDEX IF NOT EXISTS idx_expense_purposes_nome
  ON expense_purposes(lower(name));

-- As finalidades que ja existiam no codigo entram como estao, para nada mudar
-- para quem ja usa o sistema.
INSERT OR IGNORE INTO expense_purposes(name) VALUES
 ('Combustivel'),
 ('Manutencao'),
 ('Compra de equipamentos'),
 ('Limpeza'),
 ('Funcionarios'),
 ('Divulgacao'),
 ('Outros');

-- Qualquer finalidade que ja tenha sido usada em uma saida e que nao esteja na
-- lista acima entra tambem, para o cadastro refletir a realidade do historico.
INSERT OR IGNORE INTO expense_purposes(name)
SELECT DISTINCT category FROM expenses
 WHERE category IS NOT NULL AND trim(category) <> ''
   AND lower(category) NOT IN (SELECT lower(name) FROM expense_purposes);
