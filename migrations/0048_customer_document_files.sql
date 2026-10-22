-- ----------------------------------------------------------------------------
-- 0048 — TABELA customer_document_files (múltiplos anexos por documento)
--
-- Contexto: a Lima's Locações guarda até N arquivos por documento do cliente
-- nesta tabela de associação (4 linhas / 2 documentos). O Locô só tem
-- customer_documents.file_id (1 arquivo). Esta é a ÚNICA tabela nova da
-- migração — todos os demais blocos de dados couberam em colunas existentes
-- ou nas colunas portadas pela 0047.
--
-- Autorização: decisão expressa do usuário de "portar [os dados] ao destino"
-- para o bloco "múltiplos anexos por documento" (auditoria de migração).
--
-- Conservadorismo:
--   * customer_documents.file_id continua sendo o arquivo PRINCIPAL e é o
--     único que a aplicação lê hoje — as INSERTs atuais do SaaS continuam
--     funcionando sem tocar nesta tabela.
--   * Esta tabela guarda os anexos EXTRAS (position > 0). Preserva os dados;
--     nenhuma tela do Locô a lê ainda (mesma situação das colunas da 0047).
--   * company_id NOT NULL DEFAULT 1 seguindo o padrão da migration 0027
--     (multi-tenant por coluna, escopo pela sessão).
--
-- Reversão: dropar a tabela devolve exatamente o comportamento anterior
-- (anexos extras deixam de ser consultáveis; os arquivos em si permanecem
-- na tabela files).
-- ----------------------------------------------------------------------------

CREATE TABLE customer_document_files (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL DEFAULT 1,
  document_id   INTEGER NOT NULL REFERENCES customer_documents(id) ON DELETE CASCADE,
  file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX idx_customer_document_files_document
  ON customer_document_files (company_id, document_id);
