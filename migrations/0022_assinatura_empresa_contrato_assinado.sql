-- Assinatura da empresa no contrato assinado virtualmente.
--
-- A pagina do documento assinado (/contratos/assinado/[id] e a versao do
-- portal do cliente) e o documento final que vale: o texto vem do snapshot
-- congelado no ato da assinatura. O bloco da empresa entra nele quando a
-- assinatura da empresa estava cadastrada NO MOMENTO EM QUE O CLIENTE
-- ASSINOU — nao no momento da geracao do contrato, porque o contrato pode ser
-- gerado hoje e assinado daqui a dias, depois do cadastro da assinatura.
--
-- Coluna nova e opcional na tabela contract_signatures (migration 0009):
-- assinaturas antigas continuam com NULL e a pagina delas nao muda nada.
-- Migration idempotente, sem tocar em nenhuma linha existente.

ALTER TABLE contract_signatures ADD COLUMN company_signature_included INTEGER;
