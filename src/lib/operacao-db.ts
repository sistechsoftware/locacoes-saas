import "server-only";
import { all, run } from "./db";
import { tenantCompanyId } from "./tenant";
import { OPERACAO_KEYS, resolverOperacao, type OperacaoConfig } from "./operacao";

/**
 * Configurações operacionais por empresa — camada de persistência.
 *
 * Tudo é lido/escrito em company_settings (KV da migration 0027) com o
 * company_id do CONTEXTO AUTENTICADO ou do parâmetro explícito — nunca de
 * dado vindo do cliente. Não existe tabela nova nem migration: o KV por
 * empresa já é o mecanismo central do Locô para preferências (fidelidade,
 * recibos, frete, templates), e este módulo é apenas mais um conjunto de
 * chaves com o mesmo isolamento.
 */
export async function operacaoDaEmpresa(companyId: number): Promise<OperacaoConfig> {
  const rows = await all<{ key: string; value: string | null }>(
    `SELECT key, value FROM company_settings WHERE company_id = ? AND key LIKE 'op_%'`,
    [companyId],
  );
  const settings: Record<string, string> = {};
  for (const r of rows) if (r.value !== null && r.value !== undefined) settings[r.key] = r.value;
  return resolverOperacao(settings);
}

/** Configuração operacional da empresa da sessão. */
export async function getOperacao(): Promise<OperacaoConfig> {
  return operacaoDaEmpresa(await tenantCompanyId());
}

/**
 * Restaura rótulos e visibilidade ao padrão da plataforma, apagando apenas as
 * chaves `op_*` da empresa. É ação explícita do administrador e NÃO toca em
 * reservas, orçamentos, cauções, cobranças ou qualquer outro registro — os
 * dados gravados permanecem intactos e legíveis.
 */
export async function restaurarOperacaoConfig(companyId: number): Promise<void> {
  for (const key of Object.values(OPERACAO_KEYS)) {
    await run(`DELETE FROM company_settings WHERE company_id = ? AND key = ?`, [companyId, key]);
  }
}
