/**
 * Rotina diaria da fidelidade, chamada pelo cron que ja existe.
 *
 * O cron do sistema roda a cada minuto por causa dos lembretes operacionais.
 * A fidelidade nao precisa disso: expirar recompensa e avisar vencimento sao
 * tarefas de uma vez por dia, e repetir a cada minuto so gastaria consulta.
 * A marca do ultimo dia processado fica em scheduler_state.
 */
export async function runFidelityDaily(db: D1Database, nowSeconds: number) {
  const hoje = new Date((nowSeconds - 10800) * 1000).toISOString().slice(0, 10); // America/Sao_Paulo
  const marca = await db
    .prepare("SELECT value FROM scheduler_state WHERE key = 'fidelity_last_day'")
    .first<{ value: string }>();
  if (marca?.value === hoje) return null;

  await db
    .prepare(
      `INSERT INTO scheduler_state(key,value) VALUES ('fidelity_last_day',?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(hoje)
    .run();

  // o modulo usa o acesso a banco da aplicacao, entao recebe o binding por
  // runWithDb: o cron nao tem contexto de requisicao
  const { rotinaDiaria } = await import("./fidelidade-db");
  const { runWithDb } = await import("./db");
  return await runWithDb(db, rotinaDiaria);
}

/**
 * Rotina diaria dos aniversarios, no mesmo cron do resto.
 *
 * Roda uma vez por dia, a partir da hora configurada. Antes disso o dia nao e
 * marcado, entao a rotina tenta de novo no minuto seguinte: uma falha as 8h
 * nao faz a empresa perder o aviso do dia.
 */
export async function runBirthdayDaily(db: D1Database, nowSeconds: number) {
  const local = new Date((nowSeconds - 10800) * 1000); // America/Sao_Paulo
  const hoje = local.toISOString().slice(0, 10);

  const marca = await db
    .prepare("SELECT value FROM scheduler_state WHERE key = 'birthday_last_day'")
    .first<{ value: string }>();
  if (marca?.value === hoje) return null;

  const hora = await db.prepare("SELECT value FROM settings WHERE key = 'birthday_hour'").first<{ value: string }>();
  const alvo = Math.max(0, Math.min(23, Number(hora?.value ?? 8) || 0));
  if (local.getUTCHours() < alvo) return null;

  const { runWithDb } = await import("./db");
  const { rotinaAniversarios } = await import("./aniversarios-db");
  // marca o dia so depois de dar certo, para uma falha poder ser repetida
  const resultado = await runWithDb(db, () => rotinaAniversarios(hoje));
  await db
    .prepare(
      `INSERT INTO scheduler_state(key,value) VALUES ('birthday_last_day',?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(hoje)
    .run();
  return resultado;
}
