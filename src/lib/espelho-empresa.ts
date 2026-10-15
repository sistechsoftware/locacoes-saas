import { run } from "./db";

/**
 * Espelho dos dados cadastrais da empresa em `companies`.
 *
 * A fonte VISÍVEL da identidade da empresa é `company_settings` (KV lido por
 * getSettings e exibido em Configurações, recibos, contratos, portal e no topo
 * do app). A tabela `companies` é a entidade de TENANT/COBRANça: o Asaas
 * consulta companies.name/document/email, o painel SaaS lista companies.name e
 * a sessão carrega companies.name a cada request. Sem este espelho, renomear a
 * empresa em Configurações atualizava só o KV e deixava o cadastro comercial
 * (e o Asaas) para sempre com o nome do onboarding — a divergência auditada.
 *
 * Regra de sobrescrita, deliberadamente ASIMÉTRICA:
 *  * nome, telefone, whatsapp, endereço e cidade: o formulário de Configurações
 *    é o ÚNICO escritor destas colunas — o espelho é incondicional, e limpar o
 *    campo na tela limpa também no espelho (o que se vê é o que está gravado);
 *  * documento e e-mail: o onboarding também grava estas colunas direto em
 *    `companies` (CPF/CNPJ do responsável em PJ, e-mail do checkout) e o
 *    formulário pode estar vazio sem que o admin tenha apagado nada (o campo
 *    mostra o KV, que nasce vazio). Vazio NÃO sobrescreve: preserva o que o
 *    onboarding gravou — mesma regra do espelho histórico da action.
 *
 * Documento sai daqui só com dígitos (máscara removida), como a cobrança
 * exige. company_id é SEMPRE o informado pelo chamador — o contexto da sessão,
 * nunca algo derivado da requisição.
 */
export type DadosCadastraisEmpresa = {
  /** Nome exibido (company_name do formulário). */
  name: string;
  /** CNPJ/CPF como digitado; a máscara é removida aqui. */
  document: string;
  /** E-mail de contato (company_email do formulário). */
  email: string;
  phone: string;
  whatsapp: string;
  address: string;
  city: string;
};

export async function espelharDadosEmpresa(companyId: number, d: DadosCadastraisEmpresa): Promise<void> {
  const doc = String(d.document ?? "").replace(/\D/g, "");
  const email = String(d.email ?? "").trim();
  await run(
    `UPDATE companies
        SET name      = ?,
            phone     = ?,
            whatsapp  = ?,
            address   = ?,
            city      = ?,
            document  = CASE WHEN ? <> '' THEN ? ELSE document END,
            email     = CASE WHEN ? <> '' THEN ? ELSE email END,
            updated_at = datetime('now','localtime')
      WHERE id = ?`,
    [
      String(d.name ?? "").trim(),
      String(d.phone ?? "").trim(),
      String(d.whatsapp ?? "").trim(),
      String(d.address ?? "").trim(),
      String(d.city ?? "").trim(),
      doc, doc,
      email, email,
      companyId,
    ],
  );
}
