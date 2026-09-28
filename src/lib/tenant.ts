import "server-only";
import { currentCompanyId } from "./db";

/**
 * Resolução do tenant SEM dependência estática de next/headers.
 *
 * Padrão do projeto: módulos de regra (*-db.ts, stock, promocoes, chat…)
 * precisam rodar em testes e no cron, onde `next/headers` não existe. Aqui o
 * contexto autenticado (auth.ts, que importa next/*) é carregado só em runtime
 * de request; fora dele — teste, cron — a empresa padrão do banco responde.
 *
 * Em telas, a checagem de permissão acontece ANTES (requireCompanyContext), e
 * as escritas recebem o companyId do contexto: este helper nunca é fonte de
 * autoridade, apenas o escopo de leitura das rotinas de plataforma.
 */
export async function tenantCompanyId(): Promise<number> {
  try {
    const mod = await import("./auth");
    return await mod.companyIdFromRequestContext();
  } catch {
    return await currentCompanyId();
  }
}
