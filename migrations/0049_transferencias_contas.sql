-- ----------------------------------------------------------------------------
-- 0049 — TRANSFERÊNCIAS ENTRE CONTAS: ÍNDICES
--
-- As COLUNAS já chegam pela 0047 (portação da origem, aplicada em produção e
-- restaurada no repositório para convergir staging/local/testes):
--   * payments.transfer_group / transfer_counterpart_id
--   * financial_accounts.is_cash_account
--
-- Esta migração acrescenta apenas o que faltava para a feature rodar com
-- desempenho e integridade:
--
--  1. idx_pay_transfer_group — a listagem da aba Transferências agrupa por
--     transfer_group; sem índice, cada abertura varreria payments inteiro.
--     (Mesmo índice da migração 0027 da origem.)
--
--  2. idx_pay_transfer_saida_unica — barreira de DUPLICIDADE no banco: no
--     máximo UM lado de débito por evento de transferência. Um reenvio do
--     formulário com o MESMO token (clique duplo, retry após timeout,
--     requisição concorrente) estoura esta restrição e o lote inteiro é
--     revertido — a transferência não entra duas vezes. A proteção não
--     depende do botão desativado no frontend.
--
-- Nenhum dado existente é tocado: CREATE INDEX não altera linha alguma. O
-- índice único só falharia se os 8 transfer_group já migrados de produção
-- tivessem DOIS lados negativos no mesmo grupo — estado que o modelo da
-- origem nunca produz (cada evento tem exatamente um débito e um crédito).
-- Antes do apply em produção, verificar com:
--   SELECT transfer_group, COUNT(*) FROM payments
--    WHERE transfer_group IS NOT NULL AND amount_cents < 0
--    GROUP BY transfer_group HAVING COUNT(*) > 1;
-- (esperado: zero linhas)
-- ----------------------------------------------------------------------------

-- Listagem e filtros por grupo (paridade com a origem).
CREATE INDEX IF NOT EXISTS idx_pay_transfer_group ON payments(transfer_group);

-- Um único débito por transfer_group: impede lançamento duplicado no banco.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_transfer_saida_unica
  ON payments(transfer_group)
  WHERE transfer_group IS NOT NULL AND amount_cents < 0;
