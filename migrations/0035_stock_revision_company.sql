-- ----------------------------------------------------------------------------
-- REVISAO DE ESTOQUE POR EMPRESA: BACKFILL + TRIGGER PARA EMPRESAS NOVAS
--
-- Bug corrigido (staging): "O estoque ou a reserva mudou durante a
-- verificacao. Nada foi alterado; confira os dados e tente novamente."
-- (STOCK_CHANGED, src/lib/stock-write.ts) em TODA criacao de reserva de
-- empresa que nao a 1.
--
-- A 0027 transformou stock_revision de linha unica (CHECK id = 1) em UMA LINHA
-- POR EMPRESA e semeou apenas as empresas que existiam entao. Desde la nada
-- cria a linha da empresa nova:
--   * nenhum trigger em `companies` existe em migrations/ (so 0012, 0023 e
--     0027 escrevem em stock_revision, todos em tabelas de estoque);
--   * criarEmpresaComTrial() (src/lib/onboarding.ts) grava companies, users,
--     company_settings e subscriptions — e nao toca em stock_revision.
--
-- Sem a linha, stockVersion(companyId) devolve NULL e o CAS de
-- commitStockBatch compara `revision = NULL` -> CASE rende 0 -> o CHECK
-- `stock_version_matches` de stock_write_guard falha -> STOCK_CHANGED.
--
-- Por que so a reserva quebrava: os triggers de revisao fazem
-- `UPDATE stock_revision ... WHERE id = NEW.company_id`, que vira no-op sem a
-- linha — clientes, produtos e configuracoes nascem sem erro algum. Nada
-- entre a captura da versao e o commit escreve em stock_revision (o
-- checkConflicts e somente leitura e o getSettings nao persiste default), ou
-- seja: com a linha presente o CAS passa.
-- ----------------------------------------------------------------------------

-- 1) Empresas que ja existem sem linha (idempotente: quem ja tem, mantem a
--    revisao atual — o INSERT OR IGNORE preserva o contador da empresa 1).
INSERT OR IGNORE INTO stock_revision (id, revision)
  SELECT id, 0 FROM companies;

-- 2) Toda empresa futura nasce com a sua revisao. Cobre o onboarding
--    (criarEmpresaComTrial), o bootstrap da empresa 1 em db.ts e os inserts
--    diretos de `companies` usados pelos cenarios E2E.
CREATE TRIGGER IF NOT EXISTS stock_revision_companies_insert
AFTER INSERT ON companies
BEGIN
  INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (NEW.id, 0);
END;
