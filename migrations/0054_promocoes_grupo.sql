-- Promoções em massa (migração 0054).
--
-- PROBLEMA: `promotions` guardava UMA linha por produto. Aplicar a mesma regra
-- a vários produtos exigia cadastrar a mesma promoção N vezes.
--
-- SOLUÇÃO ADITIVA: `promotion_groups` é só a IDENTIDADE do grupo (nome,
-- autoria). Cada produto selecionado continua com SUA PRÓPRIA linha em
-- `promotions` e com SUAS PRÓPRIAS faixas em `promotion_tiers`, ligadas ao
-- grupo por `promotions.group_id`. O motor de preço continua lendo exatamente
-- as mesmas tabelas — nenhuma segunda lógica de cálculo nasce aqui:
--
--   * a quantidade considerada é sempre a do produto na linha do documento
--     (nunca somada entre produtos do grupo);
--   * o período é avaliado por promoção, contra a data da locação;
--   * produto fora da seleção não tem linha e não é afetado;
--   * produto cadastrado depois não entra sozinho: o vínculo é explícito.
--
-- `promotions.group_id` NULL = promoção individual, exatamente o cadastro de
-- antes. Nenhuma coluna existente é alterada e nenhum preço é reescrito.
CREATE TABLE IF NOT EXISTS promotion_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  company_id  INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_promotion_groups_company ON promotion_groups(company_id);

ALTER TABLE promotions ADD COLUMN group_id INTEGER REFERENCES promotion_groups(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_promotions_group ON promotions(group_id);

-- Um produto não pode aparecer duas vezes no mesmo grupo: seria a mesma regra
-- dobrada sobre o mesmo produto, com risco de preço duplicado/ambíguo.
CREATE UNIQUE INDEX IF NOT EXISTS idx_promotions_group_produto
  ON promotions(group_id, product_id) WHERE group_id IS NOT NULL;
