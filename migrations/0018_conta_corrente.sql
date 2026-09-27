-- Conta Corrente: conta unica do caixa e recuperacao do vinculo historico.
--
-- O campo account_id existe em payments, expenses e financial_entries desde a
-- migration 0004, mas nunca foi preenchido nos lancamentos diretos (pagamento
-- registrado na tela da reserva, saida avulsa do menu Financeiro) e o
-- historico anterior ficou sem conta. O Contas a Pagar (compras) ja pede a
-- conta; o resto ficou para tras.
--
-- Como a operacao tem uma unica Conta Corrente e toda movimentacao real de
-- caixa passou por ela, esta migration:
--   1. garante que exista uma Conta Corrente ativa. Cria apenas se NAO houver
--      nenhuma conta ativa; se o administrador ja cadastrou a dele, nada e
--      criado e nada muda de nome;
--   2. vincula ao caixa os lancamentos historicos que representam dinheiro que
--      de fato entrou ou saiu, sem alterar valor, data, reserva, cliente,
--      forma de pagamento, status ou qualquer outro campo.
--
-- O vinculo usa um predicado reversivel: `account_id IS NULL` mais a mesma
-- condicao de origem do UPDATE. Rodar de novo nao mexe em lancamento vinculado
-- nenhum (idempotente por construcao) e desfazer e um UPDATE espelhado, com a
-- seguranca de que so toca no que esta migration vinculou — ver o script
-- scripts/vincular-conta-corrente.sql, que acompanha esta migration.

INSERT INTO financial_accounts (name, kind, notes)
SELECT 'Conta Corrente', 'banco', 'Conta unica do caixa, criada automaticamente pela migration 0018.'
WHERE NOT EXISTS (SELECT 1 FROM financial_accounts WHERE active = 1);

-- O escopo do vinculo sao os dois livros do REALIZADO — payments e expenses —
-- porque por definicao toda linha deles e dinheiro que de fato entrou ou saiu
-- (os estornos sao linhas negativas do mesmo caixa). O que NAO recebe vinculo:
-- previsoes em aberto (financial_entries nao quitadas nao sao dinheiro),
-- caucoes (garantia, devolvida ao cliente) e qualquer outra entidade. Assim a
-- regra nao e indiscriminada: fica restrita ao caixa realizado, que e o que a
-- Conta Corrente representa. Com o saldo da conta sendo inicial + entradas -
-- saidas (consultas por account_id), vincular os dois livros por completo e o
-- que faz o saldo bater com o extrato do negocio.
UPDATE payments
   SET account_id = (SELECT id FROM financial_accounts WHERE active = 1 ORDER BY id LIMIT 1)
 WHERE account_id IS NULL;

UPDATE expenses
   SET account_id = (SELECT id FROM financial_accounts WHERE active = 1 ORDER BY id LIMIT 1)
 WHERE account_id IS NULL;

-- As consultas de saldo por conta (Configuracoes > Contas) somam por account_id;
-- sem indice viraria varredura completa a cada tela.
CREATE INDEX IF NOT EXISTS idx_pay_account ON payments(account_id);
CREATE INDEX IF NOT EXISTS idx_exp_account ON expenses(account_id);
