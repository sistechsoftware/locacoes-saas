-- ===========================================================================
-- Conta Corrente: mesma logica da migration 0018, em versao executavel e
-- re-executavel, para testar localmente com contagem ANTES / DEPOIS.
--
-- Como usar (Windows PowerShell, na raiz do projeto):
--   npx wrangler d1 execute limas-locacoes --local --file scripts/vincular-conta-corrente.sql
--
-- Idempotente: o predicado e `account_id IS NULL` + mesma condicao de origem
-- da migration. Rodar quantas vezes quiser; nada e vinculado duas vezes,
-- nenhum valor, data, status ou origem e alterado. So o vinculo e criado.
-- ===========================================================================

-- ---- 1. Garante a Conta Corrente (so cria se nenhuma ativa existir) --------
INSERT INTO financial_accounts (name, kind, notes)
SELECT 'Conta Corrente', 'banco', 'Conta unica do caixa, criada automaticamente pela migration 0018.'
WHERE NOT EXISTS (SELECT 1 FROM financial_accounts WHERE active = 1);

-- ---- 2. ANTES: retrato dos lancamentos sem conta ---------------------------
SELECT 'ANTES' AS momento, 'conta_corrente' AS item,
       (SELECT COUNT(*) FROM financial_accounts WHERE active = 1) AS qtd_contas,
       (SELECT COUNT(*) FROM payments WHERE account_id IS NULL)  AS pagamentos_sem_conta,
       (SELECT COUNT(*) FROM payments)                           AS pagamentos_total,
       (SELECT COALESCE(SUM(amount_cents),0) FROM payments)      AS pagamentos_valor,
       (SELECT COUNT(*) FROM expenses WHERE account_id IS NULL)  AS saidas_sem_conta,
       (SELECT COUNT(*) FROM expenses)                           AS saidas_total,
       (SELECT COALESCE(SUM(amount_cents),0) FROM expenses)      AS saidas_valor;

-- ---- 3. Vinculo historico (idempotente) ------------------------------------
-- Escopo: os dois livros do REALIZADO (payments e expenses). Previsoes em
-- aberto e caucoes nao sao dinheiro e ficam de fora. Ver migration 0018.
UPDATE payments
   SET account_id = (SELECT id FROM financial_accounts WHERE active = 1 ORDER BY id LIMIT 1)
 WHERE account_id IS NULL;

UPDATE expenses
   SET account_id = (SELECT id FROM financial_accounts WHERE active = 1 ORDER BY id LIMIT 1)
 WHERE account_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_pay_account ON payments(account_id);
CREATE INDEX IF NOT EXISTS idx_exp_account ON expenses(account_id);

-- ---- 4. DEPOIS: mesmo retrato. Unica diferenca esperada: menos sem conta ----
SELECT 'DEPOIS' AS momento, 'conta_corrente' AS item,
       (SELECT COUNT(*) FROM financial_accounts WHERE active = 1) AS qtd_contas,
       (SELECT COUNT(*) FROM payments WHERE account_id IS NULL)  AS pagamentos_sem_conta,
       (SELECT COUNT(*) FROM payments)                           AS pagamentos_total,
       (SELECT COALESCE(SUM(amount_cents),0) FROM payments)      AS pagamentos_valor,
       (SELECT COUNT(*) FROM expenses WHERE account_id IS NULL)  AS saidas_sem_conta,
       (SELECT COUNT(*) FROM expenses)                           AS saidas_total,
       (SELECT COALESCE(SUM(amount_cents),0) FROM expenses)      AS saidas_valor;

-- ---- 5. Conferencia de integridade ----------------------------------------
-- Totais por conta devem bater com os globais (ninguem ficou fora nem duplicado)
SELECT a.name,
       COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.account_id = a.id),0) AS entradas_vinculadas,
       COALESCE((SELECT SUM(e.amount_cents) FROM expenses e WHERE e.account_id = a.id),0) AS saidas_vinculadas,
       a.initial_balance_cents
  FROM financial_accounts a WHERE a.active = 1;

-- ===========================================================================
-- Desfazer (somente se precisar): reverte o vinculo APENAS com a conta que a
-- propria migration criou (reconhecivel pelo notes). Se o administrador ja tinha
-- a conta dele, a migration nao criou nada e este rollback nao se aplica.
-- Nao apaga lancamento, nao mexe em valores, nao toca em outra conta.
--
-- UPDATE payments SET account_id = NULL
--  WHERE account_id = (SELECT id FROM financial_accounts
--                       WHERE notes LIKE '%migration 0018%' AND active = 1);
--
-- UPDATE expenses SET account_id = NULL
--  WHERE account_id = (SELECT id FROM financial_accounts
--                       WHERE notes LIKE '%migration 0018%' AND active = 1);
-- ===========================================================================
