-- Modelo de contrato digital: separacao entre o contrato impresso e o contrato
-- assinado online.
--
-- O modelo digital fica na tabela settings, chave contract_template_digital,
-- no mesmo formato KV dos demais ajustes: nada a criar aqui. Esta migration
-- adiciona apenas o carimbo de congelamento do corpo: na primeira abertura do
-- link pelo cliente, o corpo passa a valer o texto do modelo digital com a
-- data da abertura ({{data_assinatura_digital}}), e de la em diante nao muda
-- mais. Coluna nova e opcional: contratos existentes continuam com NULL e
-- seguem funcionando exatamente como antes.

ALTER TABLE contracts ADD COLUMN body_frozen_at TEXT;
