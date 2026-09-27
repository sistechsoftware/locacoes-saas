-- Assinatura digital da empresa (proprietario/administrador).
--
-- Funcionalidade puramente aditiva: nada aqui toca em contrato, recibo,
-- pagamento, caucao, cliente ou configuracao ja existente. A imagem vive na
-- tabela `files` que ja existe (mesmo lugar da logo, dos avatares e das
-- assinaturas dos clientes) e a referencia fica na tabela `settings`
-- (company_signature_file_id, chave KV como os demais ajustes) — nenhuma
-- tabela nova e necessaria.
--
-- As duas colunas abaixo marcam QUEM emitiu o documento quando a assinatura da
-- empresa estava cadastrada no momento da geracao. Sao colunas novas e
-- opcionais: contratos e recibos antigos continuam com NULL e sao exibidos
-- exatamente como sempre foram — um documento ja gerado nunca ganha nem perde
-- a assinatura da empresa depois de pronto.
--
-- Migration idempotente e sem risco de dados: ALTER TABLE ADD COLUMN nao
-- altera nenhuma linha existente.

ALTER TABLE contracts ADD COLUMN company_signature_included INTEGER;
ALTER TABLE receipts  ADD COLUMN company_signature_included INTEGER;
