import "server-only";
import { all, batch } from "./db";
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
 * Grava as configurações operacionais da empresa em UM batch atômico.
 *
 * Duas disciplinas de desempenho, medidas contra o custo real do D1 remoto
 * (ida de ida por statement):
 *  - só chaves cujo valor MUDOU são escritas — salvar sem alteração não gera
 *    escrita nem bump de revisão de estoque (o trigger de company_settings
 *    incrementa stock_revision a cada upsert);
 *  - as escritas que sobraram vão num único `batch()` (transação única), em
 *    vez de uma consulta sequencial por chave.
 */
export async function salvarOperacaoConfig(
  values: Record<string, string>,
  companyId: number,
): Promise<void> {
  const atuais = await all<{ key: string; value: string | null }>(
    `SELECT key, value FROM company_settings WHERE company_id = ? AND key LIKE 'op_%'`,
    [companyId],
  );
  const atuaisMap = new Map(atuais.map((r) => [r.key, r.value ?? ""]));
  await batch(
    Object.entries(values)
      .filter(([key, value]) => atuaisMap.get(key) !== value)
      .map(([key, value]) => ({
        sql: `INSERT INTO company_settings (company_id, key, value) VALUES (?,?,?)
                ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`,
        params: [companyId, key, value],
      })),
  );
}

/**
 * Restaura rótulos, visibilidade e perfil ao padrão da plataforma, apagando
 * apenas as chaves `op_*` da empresa (lista explícita, um único batch).
 * É ação explícita do administrador e NÃO toca em reservas, orçamentos,
 * cauções, cobranças ou qualquer outro registro — os dados gravados
 * permanecem intactos e legíveis.
 */
export async function restaurarOperacaoConfig(companyId: number): Promise<void> {
  await batch(
    Object.values(OPERACAO_KEYS).map((key) => ({
      sql: `DELETE FROM company_settings WHERE company_id = ? AND key = ?`,
      params: [companyId, key],
    })),
  );
}
