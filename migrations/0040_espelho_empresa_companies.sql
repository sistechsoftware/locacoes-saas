-- ============================================================================
-- 0040 — ESPELHO DOS DADOS DA EMPRESA EM `companies`
-- ----------------------------------------------------------------------------
-- A tela Configurações → Empresa grava a identidade visível em
-- `company_settings` (KV lido por recibos, contratos, portal e topo do app),
-- mas só espelhava document/email em `companies` — colunas que a cobrança
-- (Asaas), o painel SaaS e a sessão consultam. Renomear a empresa mudava só o
-- KV: `companies.name` ficava para sempre com o nome do onboarding (auditoria
-- 2026-10-15).
--
-- Esta migration faz o BACKFILL único que sincroniza `companies` com o que a
-- tela mostra hoje. A partir do deploy, a action saveCompanySettings mantém o
-- espelho a cada salvamento (src/lib/espelho-empresa.ts).
--
-- GARANTIAS
--  * Aditiva: não cria, não dropa e não reescreve tabela — só UPDATE de colunas
--    cadastrais já existentes (0027).
--  * Idempotente em VALORES: rodar de novo não altera dado (updated_at é a
--    única coluna que se repete).
--  * NÃO sobrescreve com vazio: settings ausente ou string vazia preserva o
--    que já está em companies (empresas novas sem KV de identidade não são
--    tocadas).
--  * documento: normalizado só com dígitos (mesma regra do formulário), com
--    fallback para companies.document quando o KV vem vazio — protege o
--    documento gravado pelo onboarding em PJ.
--  * email: mesma proteção de vazio (o onboarding grava companies.email
--    direto no checkout).
--  * Sem transação SQL explícita: o D1 remoto rejeita (erro 7500); o lote do
--    UPDATE é atomico por si só.
-- ============================================================================

UPDATE companies SET
  name = COALESCE(
    NULLIF((SELECT s.value FROM company_settings s
             WHERE s.company_id = companies.id AND s.key = 'company_name'), ''),
    name),
  phone = COALESCE(
    NULLIF((SELECT s.value FROM company_settings s
             WHERE s.company_id = companies.id AND s.key = 'company_phone'), ''),
    phone),
  whatsapp = COALESCE(
    NULLIF((SELECT s.value FROM company_settings s
             WHERE s.company_id = companies.id AND s.key = 'company_whatsapp'), ''),
    whatsapp),
  address = COALESCE(
    NULLIF((SELECT s.value FROM company_settings s
             WHERE s.company_id = companies.id AND s.key = 'company_address'), ''),
    address),
  city = COALESCE(
    NULLIF((SELECT s.value FROM company_settings s
             WHERE s.company_id = companies.id AND s.key = 'company_city'), ''),
    city),
  document = COALESCE(
    NULLIF(
      REPLACE(REPLACE(REPLACE(REPLACE(
        NULLIF((SELECT s.value FROM company_settings s
                 WHERE s.company_id = companies.id AND s.key = 'company_doc'), ''),
        '.', ''), '-', ''), '/', ''), ' ', ''),
      ''),
    document),
  email = COALESCE(
    NULLIF((SELECT s.value FROM company_settings s
             WHERE s.company_id = companies.id AND s.key = 'company_email'), ''),
    email),
  updated_at = datetime('now','localtime')
WHERE EXISTS (
  SELECT 1 FROM company_settings s
   WHERE s.company_id = companies.id
     AND s.key IN ('company_name','company_phone','company_whatsapp',
                   'company_address','company_city','company_doc','company_email')
     AND s.value IS NOT NULL AND s.value <> ''
);
