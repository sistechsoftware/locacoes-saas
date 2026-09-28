/**
 * Rotinas diárias da fidelidade e dos aniversários, chamadas pelo cron.
 *
 * Multi-empresa (Etapa 2): as rotinas rodam no escopo de UMA empresa por vez —
 * o worker itera as empresas ativas e chama cada rotina dentro de
 * runWithCompany(cid), de modo que getSettings(), tenantCompanyId() e
 * currentCompanyId() resolvam para a empresa sendo processada. As marcas
 * "dia já processado" (scheduler_state) ficam por empresa.
 */
import { runWithCompany, runWithDb } from "./db";

/**
 * Roda `rotina` uma vez por empresa ativa, com o contexto fixado.
 *
 * Uma empresa que falhe não impede as demais: cada execução é capturada e
 * devolvida rotulada, para o worker logar uma a uma.
 */
export async function paraCadaEmpresa<T>(
  db: D1Database,
  rotina: (companyId: number, name: string) => Promise<T>,
): Promise<({ companyId: number; name: string; ok: true; valor: T } | { companyId: number; name: string; ok: false; erro: string })[]> {
  const r = await db
    .prepare("SELECT id, name FROM companies WHERE active = 1 ORDER BY id")
    .all<{ id: number; name: string }>();
  const empresas = r.results ?? [];
  const resultados: ({ companyId: number; name: string; ok: true; valor: T } | { companyId: number; name: string; ok: false; erro: string })[] = [];
  for (const e of empresas) {
    try {
      const valor = await runWithCompany(e.id, () => rotina(e.id, e.name));
      resultados.push({ companyId: e.id, name: e.name, ok: true, valor });
    } catch (err) {
      resultados.push({ companyId: e.id, name: e.name, ok: false, erro: err instanceof Error ? err.message : String(err) });
    }
  }
  return resultados;
}

/**
 * Rotina diária da fidelidade, no escopo da empresa do contexto.
 *
 * O cron do sistema roda a cada minuto por causa dos lembretes operacionais.
 * A fidelidade não precisa disso: expirar recompensa e avisar vencimento são
 * tarefas de uma vez por dia, e repetir a cada minuto só gastaria consulta.
 * A marca do último dia processado fica em scheduler_state, POR EMPRESA.
 */
export async function runFidelityDaily(db: D1Database, nowSeconds: number) {
  const { companyContextAtual, currentCompanyId } = await import("./db");
  const companyId = companyContextAtual() ?? (await currentCompanyId());
  const hoje = new Date((nowSeconds - 10800) * 1000).toISOString().slice(0, 10); // America/Sao_Paulo
  const marca = `fidelity_last_day:c${companyId}`;
  const row = await db
    .prepare("SELECT value FROM scheduler_state WHERE key = ?")
    .bind(marca)
    .first<{ value: string }>();
  if (row?.value === hoje) return null;

  await db
    .prepare(
      `INSERT INTO scheduler_state(key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(marca, hoje)
    .run();

  // o módulo usa o acesso a banco da aplicacao, entao recebe o binding por
  // runWithDb: o cron nao tem contexto de requisicao
  const { rotinaDiaria } = await import("./fidelidade-db");
  return await runWithDb(db, () => rotinaDiaria());
}

/**
 * Rotina diária dos aniversários, no mesmo cron do resto, por empresa.
 *
 * Roda uma vez por dia, a partir da hora configurada (company_settings da
 * empresa). Antes disso o dia não é marcado, então a rotina tenta de novo no
 * minuto seguinte: uma falha às 8h não faz a empresa perder o aviso do dia.
 */
export async function runBirthdayDaily(db: D1Database, nowSeconds: number) {
  const { companyContextAtual, currentCompanyId } = await import("./db");
  const companyId = companyContextAtual() ?? (await currentCompanyId());
  const local = new Date((nowSeconds - 10800) * 1000); // America/Sao_Paulo
  const hoje = local.toISOString().slice(0, 10);

  const marca = `birthday_last_day:c${companyId}`;
  const row = await db
    .prepare("SELECT value FROM scheduler_state WHERE key = ?")
    .bind(marca)
    .first<{ value: string }>();
  if (row?.value === hoje) return null;

  const { getSettings } = await import("./settings");
  const hora = Number((await getSettings()).birthday_hour ?? 8) || 0;
  const alvo = Math.max(0, Math.min(23, hora));
  if (local.getUTCHours() < alvo) return null;

  const { rotinaAniversarios } = await import("./aniversarios-db");
  // marca o dia so depois de dar certo, para uma falha poder ser repetida
  const resultado = await runWithDb(db, () => rotinaAniversarios(hoje));
  await db
    .prepare(
      `INSERT INTO scheduler_state(key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(marca, hoje)
    .run();
  return resultado;
}
