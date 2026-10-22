-- ----------------------------------------------------------------------------
-- 0047 — COLUNAS DA ORIGEM (Lima's Locações) PORTADAS AO DESTINO
--
-- Contexto: a Lima's Locações opera hoje num sistema single-tenant com colunas
-- que o Locô nunca recebeu (a feature não foi portada durante a virada SaaS).
-- Nesta migração elas são PORTADAS para o destino, preservando a definição
-- EXATA da origem, para que nenhum dado histórico seja perdido na transferência.
--
-- Autorização: decisão expressa do usuário de "portar as colunas ao destino"
-- (auditoria de migração, bloco "dados sem casa"). Sem isso estas colunas não
-- existiriam no SaaS.
--
-- O que cada uma guarda (semântica preservada da origem):
--   * payments.transfer_group / transfer_counterpart_id — os dois lados de uma
--     transferência entre contas apontam um para o outro (migration 0027 da
--     origem). NULL = lançamento comum, sem comportamento de transferência.
--     A feature de transferências NÃO existe na interface do Locô estes dados
--     ficam presentes porém dormentes até que a tela seja construída.
--   * financial_accounts.is_cash_account — natureza "dinheiro em espécie"
--     (carteira/caixa físico) de uma conta financeira.
--   * customers.is_lead — marcava um cadastro como lead de orçamento.
--   * customer_documents.document_date/status/updated_at — metadados do
--     documento do cliente (status era NOT NULL DEFAULT 'ativo' na origem).
--
-- Efeitos sobre os dados EXISTENTES do SaaS: nenhum valor é alterado. Colunas
-- novas nascem com DEFAULT neutro (0 / 'ativo' / NULL), então as linhas já
-- gravadas pelos clientes atuais continuam corretas e as INSERTs atuais da
-- aplicação (que não citam estas colunas) continuam funcionando — o DEFAULT
-- cobre a omissão.
--
-- Nenhuma tabela nova, nenhum índice novo, nenhum dado existente é tocado.
-- ----------------------------------------------------------------------------

-- Lado "origem" da transferência (NULL = não é transferência).
ALTER TABLE payments ADD COLUMN transfer_group TEXT;

-- Par do evento: o débito aponta para o crédito e vice-versa. ON DELETE SET
-- NULL igual à origem: apagar um lado isoladamente não apaga o outro em cascata.
-- (SQLite exige default NULL quando a coluna tem REFERENCES — já é o caso.)
ALTER TABLE payments
  ADD COLUMN transfer_counterpart_id INTEGER REFERENCES payments(id) ON DELETE SET NULL;

-- Natureza do dinheiro: 0 = conta comum (estado atual de toda conta do SaaS).
ALTER TABLE financial_accounts ADD COLUMN is_cash_account INTEGER NOT NULL DEFAULT 0;

-- Lead de orçamento: 0 = cliente comum (estado atual de todo cadastro do SaaS).
ALTER TABLE customers ADD COLUMN is_lead INTEGER NOT NULL DEFAULT 0;

-- Metadados de documento do cliente. status era NOT NULL DEFAULT 'ativo' na
-- origem; o mesmo DEFAULT aqui mantém as INSERTs do SaaS (que não enviam
-- status) funcionando sem alterar a aplicação.
ALTER TABLE customer_documents ADD COLUMN document_date TEXT;
ALTER TABLE customer_documents ADD COLUMN status TEXT NOT NULL DEFAULT 'ativo';
ALTER TABLE customer_documents ADD COLUMN updated_at TEXT;
