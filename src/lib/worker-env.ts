/**
 * Env do Worker para código que roda FORA de uma requisição.
 *
 * Em request, getCloudflareContext() (@opennextjs/cloudflare) devolve env,
 * secrets e bindings — é o caminho padrão da aplicação. O handler `scheduled`
 * do cron (custom-worker.ts) NÃO roda com runWithCloudflareRequestContext, então
 * ali o getCloudflareContext() lança e qualquer leitura de secret via contexto
 * falha.
 *
 * Consequência real (auditoria 2026-10-13): todo e-mail gerado pelo cron era
 * pulado com motivo sem_contexto — produção registrou o aviso de fim de trial
 * de 2026-10-13 03:00 sem conseguir ler RESEND_* nem PUBLIC_URL.
 *
 * Em vez de reimplementar o acesso a dados só para o agendador (padrão já
 * usado pelo db.runWithDb), o agendador entrega o env que recebeu da
 * plataforma. O env do cron é o MESMO script/versionamento do de fetch — mesmas
 * vars e secrets — então guardá-lo em módulo não muda o comportamento de
 * ninguém.
 *
 * Regra: só o AGENDADOR preenche isto (custom-worker). Testes podem usar
 * definirEnvDoAgendador/limparEnvDoAgendador como gancho.
 */

/** Guardado como unknown: o env do Worker é um objeto de bindings tipado por ambiente. */
let envAgendador: Record<string, unknown> | null = null;

/** Recebe o env do handler `scheduled`. Aceita qualquer shape de binding. */
export function definirEnvDoAgendador(env: unknown): void {
  envAgendador = (env ?? null) as Record<string, unknown> | null;
}

/** Limpa o env do agendador (gancho de teste / higiene entre execuções). */
export function limparEnvDoAgendador(): void {
  envAgendador = null;
}

/** Env do agendador quando existe; null quando o código não está no cron. */
export function envDoAgendador(): Record<string, unknown> | null {
  return envAgendador;
}

/** Variável/secret do Worker lido fora de request — null quando ausente. */
export function varDoAgendador(nome: string): string | null {
  const valor = envAgendador?.[nome];
  return typeof valor === "string" && valor ? valor : null;
}

/**
 * Lê uma variável/secret do Worker em QUALQUER contexto:
 *  * em request, o env do getCloudflareContext() é a autoridade;
 *  * fora de request (cron), o env entregue ao handler `scheduled`.
 *
 * Evita que configurações (PAINEL_CHAVE, ASAAS_*, RESEND_*, PUBLIC_URL) se
 * tornem invisíveis nas rotinas agendadas — o mesmo problema de sem_contexto
 * que derrubava os e-mails do cron.
 */
export async function lerVarWorker(nome: string): Promise<string | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    // Só chega aqui quem ESTÁ em request: o env da plataforma é a fonte única
    // de verdade (mesmo que a variável venha vazia).
    const valor = (getCloudflareContext().env as unknown as Record<string, unknown>)[nome];
    if (typeof valor === "string" && valor) return valor;
    return null;
  } catch {
    // getCloudflareContext() lança fora de request (cron) e fora do Worker:
    // ali o env do agendador é quem tem os secrets.
    return varDoAgendador(nome);
  }
}
