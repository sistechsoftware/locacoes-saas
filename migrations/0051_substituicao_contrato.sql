-- ============================================================================
-- 0051 — SUBSTITUICAO DE CONTRATO (revogacao logica + linhagem)
-- ----------------------------------------------------------------------------
-- Problema real: o contrato de uma reserva e um retrato do momento em que foi
-- gerado (contracts.body) e da versao que o cliente leu e assinou
-- (contract_signatures.body_snapshot). Quando os dados cadastrais da empresa
-- mudam depois da assinatura, o documento vigente fica desatualizado — e nao
-- existe hoje nenhuma forma de revoga-lo sem apagar a prova do que foi aceito
-- (DELETE em contracts derruba contract_signatures em cascata).
--
-- Esta migration so ADICIONA colunas: nada e reconstruido, nenhuma linha e
-- tocada e contratos antigos continuam com NULL exatamente como antes.
--
--   * revoked_at / revoked_reason / revoked_by: registram a revogacao do
--     contrato (quem, quando e por que) sem depender do audit_logs.
--   * superseded_by_id: o contrato que substituiu este (lado "antigo").
--   * replaces_id: o contrato que este substitui (lado "novo"), para o
--     documento novo dizer de onde veio.
--   * contract_signatures.company_signature_file_id: congela QUAL arquivo de
--     assinatura da locadora apareceu no documento assinado. Antes so existia
--     o booleano company_signature_included e a imagem era lida das settings
--     atuais — trocar a assinatura da empresa alterava (ou quebrava) a imagem
--     de documentos ja assinados.
--
-- O status continua no CHECK existente ('pendente','enviado','assinado',
-- 'encerrado','cancelado'): o contrato revogado fica 'cancelado' e a
-- substituicao e expressa pelas colunas de linhagem, sem reconstruir a tabela
-- no D1.
-- ============================================================================

ALTER TABLE contracts ADD COLUMN revoked_at TEXT;
ALTER TABLE contracts ADD COLUMN revoked_reason TEXT;
ALTER TABLE contracts ADD COLUMN revoked_by INTEGER;
ALTER TABLE contracts ADD COLUMN superseded_by_id INTEGER;
ALTER TABLE contracts ADD COLUMN replaces_id INTEGER;

ALTER TABLE contract_signatures ADD COLUMN company_signature_file_id TEXT;

CREATE INDEX IF NOT EXISTS idx_contracts_superseded ON contracts(superseded_by_id);
CREATE INDEX IF NOT EXISTS idx_contracts_replaces ON contracts(replaces_id);
