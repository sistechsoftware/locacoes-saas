// @ts-ignore OpenNext generates this module during the deployment build.
import handler from "./.open-next/worker.js";
import { runWithDb } from "./src/lib/db";
import { comContextoDeInvocacao, contextoAtual, marcarConsulta } from "./src/lib/perf";
import { runNotificationScheduler, webPushSender } from "./src/lib/push-scheduler";
import { runBirthdayDaily, runFidelityDaily, paraCadaEmpresa } from "./src/lib/fidelidade-cron";
import { mensagemDeErro, podarErrosAntigos, registrarErro } from "./src/lib/error-log";
import { definirEnvDoAgendador } from "./src/lib/worker-env";

export default {
  /**
   * Observabilidade (auditoria de CPU/latencia): cada invocacao roda com
   * contexto proprio para contar idas ao D1 e medir duracao total. So vira
   * log o que vale a pena investigar (>=1500ms de parede OU >=30 idas ao D1)
   * — nenhum dado sensivel entra na linha (so rota, status, ms e consultas).
   *
   * `ms` e TEMPO DE PAREDE ate a resposta ficar pronta, NAO CPU time. CPU
   * time por execucao vem do painel Cloudflare (Workers Logs / metrica
   * "CPU Time per execution"); esta linha nao substitui aquela metrica.
   */
  fetch: (request: Request, env: CloudflareEnv, ctx: ExecutionContext) =>
    comContextoDeInvocacao(async () => {
      const inicio = Date.now();
      let status = 0;
      try {
        const resposta = await handler.fetch(request, env, ctx);
        status = resposta.status;
        return resposta;
      } finally {
        const ms = Date.now() - inicio;
        const consultas = contextoAtual()?.consultas ?? 0;
        // Em producao (PUBLIC_URL preenchido) so o que exige investigacao vira
        // log; localmente (bloco top-level do wrangler, PUBLIC_URL vazio, nunca
        // deployado) toda requisicao loga, para medicao de auditoria. Isso
        // evita log excessivo em producao sem cegar a medicao local.
        const local = !env.PUBLIC_URL;
        if (local || ms >= 1500 || consultas >= 30) {
          console.log(
            JSON.stringify({ event: "perf", rota: new URL(request.url).pathname, status, ms, consultas }),
          );
        }
      }
    }),
  async scheduled(event, env, ctx) {
    // Contexto do cron: contagem de consultas e duracao por tick. O wrapper
    // cobre tambem os promises entregues ao ctx.waitUntil abaixo — eles nascem
    // dentro do contexto e o log final espera os tres.
    return comContextoDeInvocacao(async () => {
      const inicioTick = Date.now();
      const tarefas: Promise<unknown>[] = [];
      const agendar = (p: Promise<unknown>) => {
        tarefas.push(p);
        ctx.waitUntil(p);
      };
    // O cron NÃO roda com runWithCloudflareRequestContext (só o fetch do OpenNext
    // envolve a request), então getCloudflareContext() lança dentro das rotinas
    // agendadas. Entregar o env ao módulo worker-env mantém leitura de secret
    // fora de request: RESEND_API_KEY/RESEND_FROM (e-mails do cron: fim de trial,
    // cobrança gerada) e PUBLIC_URL (links desses e-mails). Evidência da falha
    // anterior: error_logs de produção com motivo sem_contexto às 03:00.
    definirEnvDoAgendador(env);

    const now = Math.floor(event.scheduledTime / 1000);
    const sender =
      env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
        ? webPushSender({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT })
        : undefined;

    /** Registra a falha de UMA empresa no diario de erros, sem derrubar as outras. */
    const registrarFalhaDeEmpresa = (rotina: string, route: string, r: { companyId: number; name: string; ok: false; erro: string }) => {
      console.error(`${rotina}_error (empresa ${r.companyId} - ${r.name}):`, r.erro);
      return registrarErro({
        source: "cron",
        kind: "server",
        message: mensagemDeErro(new Error(r.erro)),
        route,
        // Pendência #07: este loop roda DEPOIS de paraCadaEmpresa (o contexto
        // runWithCompany já foi restaurado), então a empresa vem explícita do
        // resultado — sem isto a falha de toda empresa cairia na empresa 1.
        companyId: r.companyId,
        context: { rotina, companyId: r.companyId, empresa: r.name },
      });
    };

    // Toda rotina registra a propria falha: sem isso, uma quebra fica invisivel
    // e a rotina simplesmente para de acontecer. O diario error_logs guarda
    // cada falha com o dia em que ocorreu (fonte "cron"), visivel em /erros.
    //
    // Multi-empresa (Etapa 2): cada rotina roda UMA VEZ POR EMPRESA ATIVA,
    // dentro de runWithCompany(cid) — as leituras de plataforma (settings,
    // usuarios, atividades) ficam escopadas na empresa sendo processada.
    agendar(
      runWithDb(env.DB, async () => {
        const resultados = await paraCadaEmpresa(env.DB, (cid, nome) =>
          runNotificationScheduler(env.DB, now, sender).then((r) => {
            console.log(JSON.stringify({ event: "notification_cron", company: cid, empresa: nome, ...r }));
          }),
        );
        for (const r of resultados) if (!r.ok) await registrarFalhaDeEmpresa("notification_cron", "cron/notificacoes", r);
      })
        .catch((e) => {
          console.error("notification_cron_error:", e);
          // Fora de request nao existe getCloudflareContext(): o acesso ao D1
          // no cron passa pelo runWithDb, como as demais rotinas agendadas.
          return runWithDb(env.DB, () =>
            registrarErro({
              source: "cron", kind: "server",
              message: mensagemDeErro(e),
              route: "cron/notificacoes",
              // Pendência #07: falha do loop inteiro, sem empresa atribuível →
              // global (NULL). companyId explícito para não herdar o contexto
              // de outra rotina — os cron rodam concorrentes no mesmo isolate.
              companyId: null,
              context: { rotina: "runNotificationScheduler" },
            }),
          );
        }),
    );
    // fidelidade uma vez por dia, POR EMPRESA: expirar recompensas e preparar
    // lembretes nao pode depender de alguem abrir o sistema
    agendar(
      runWithDb(env.DB, async () => {
        const resultados = await paraCadaEmpresa(env.DB, (cid, nome) =>
          runFidelityDaily(env.DB, now).then((r) => {
            if (r) console.log(JSON.stringify({ event: "fidelity_cron", company: cid, empresa: nome, ...r }));
          }),
        );
        for (const r of resultados) if (!r.ok) await registrarFalhaDeEmpresa("fidelity_cron", "cron/fidelidade", r);
      })
        .catch((e) => {
          console.error("fidelity_cron_error:", e);
          return runWithDb(env.DB, () =>
            registrarErro({
              source: "cron", kind: "server",
              message: mensagemDeErro(e),
              route: "cron/fidelidade",
              companyId: null, // global: falha do loop, sem empresa atribuível
              context: { rotina: "runFidelityDaily" },
            }),
          );
        }),
    );
    // aniversarios: uma falha aqui (ou numa empresa) nao derruba as outras rotinas
    agendar(
      runWithDb(env.DB, async () => {
        const resultados = await paraCadaEmpresa(env.DB, (cid, nome) =>
          runBirthdayDaily(env.DB, now).then((r) => {
            if (r) console.log(JSON.stringify({ event: "birthday_cron", company: cid, empresa: nome, ...r }));
          }),
        );
        for (const r of resultados) if (!r.ok) await registrarFalhaDeEmpresa("birthday_cron", "cron/aniversarios", r);
      })
        .catch((e) => {
          console.error("birthday_cron_error:", e);
          return runWithDb(env.DB, () =>
            registrarErro({
              source: "cron", kind: "server",
              message: mensagemDeErro(e),
              route: "cron/aniversarios",
              companyId: null, // global: falha do loop, sem empresa atribuível
              context: { rotina: "runBirthdayDaily" },
            }),
          );
        }),
    );
    // Camada comercial (Etapa 3): trial/periodo/inadimplencia — PLATAFORMA,
    // uma vez por dia (marca global, nao por empresa). A rotina cobre todas as
    // empresas internamente.
    agendar(
      runWithDb(env.DB, async () => {
        const hoje = new Date((now - 10800) * 1000).toISOString().slice(0, 10); // America/Sao_Paulo
        const marca = `billing_last_day`;
        marcarConsulta();
        const row = await env.DB.prepare("SELECT value FROM scheduler_state WHERE key = ?").bind(marca).first<{ value: string }>();
        if (row?.value === hoje) return;
        marcarConsulta();
        await env.DB
          .prepare("INSERT INTO scheduler_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .bind(marca, hoje)
          .run();
        // Import DEPOIS da marca do dia: modules abaixo (billing, recuperacao,
        // plano-personalizado) pesam CPU para instanciar e o cron os carregaria
        // 1.440x/dia sem necessidade — so quando o dia ainda nao rodou.
        const { rotinaDiariaBilling } = await import("./src/lib/billing");
        const r = await rotinaDiariaBilling();
        // Etapa 5: tokens de recuperação vencidos saem do banco junto.
        const { limparTokensExpirados } = await import("./src/lib/recuperacao");
        const tokensApagados = await limparTokensExpirados().catch(() => -1);
        // Cortesias (0039): registra início/término no audit_logs. A VIGÊNCIA
        // em si é derivada do tempo em cada autorização de acesso — se esta
        // rotina falhar, nenhuma cortesia expirada continua liberando nada.
        const { rotinaCortesias } = await import("./src/lib/plano-personalizado");
        const cortesias = await rotinaCortesias().catch(() => ({ iniciadas: -1, encerradas: -1 }));
        console.log(JSON.stringify({ event: "billing_cron", ...r, tokensApagados, cortesias }));
      })
        .catch((e) => {
          console.error("billing_cron_error:", e);
          return runWithDb(env.DB, () =>
            registrarErro({
              source: "cron", kind: "server",
              message: mensagemDeErro(e),
              route: "cron/billing",
              companyId: null, // rotina de plataforma: erro global por natureza
              context: { rotina: "rotinaDiariaBilling" },
            }),
          );
        }),
    );
    // limpezas GLOBAIS, uma unica vez por ciclo (sairam do laco por empresa):
    // cache de rotas e rate limits nao pertencem a nenhuma empresa
    marcarConsulta(); // batch = 1 ida
    agendar(
      env.DB.batch([
        env.DB.prepare("DELETE FROM route_cache WHERE expires_at<?").bind(now),
        env.DB.prepare("DELETE FROM api_rate_limits WHERE expires_at<?").bind(now),
      ]).catch(() => {}),
    );
    // manutencao do proprio diario: nada de erro cresce para sempre (30 dias)
    agendar(podarErrosAntigos(env.DB).catch(() => {}));

    // Uma linha por tick: duracao total das rotinas e idas ao D1 do tick
    // inteiro (todas as rotinas compartilham o contexto acima). Sem dado
    // sensivel; `ms` e de parede, nao CPU time. O agregador NAO entra em
    // `tarefas` (senao o allSettled esperaria a ele mesmo).
    ctx.waitUntil(
      Promise.allSettled(tarefas).then(() =>
        console.log(
          JSON.stringify({
            event: "cron_tick",
            ms: Date.now() - inicioTick,
            consultas: contextoAtual()?.consultas ?? 0,
          }),
        ),
      ),
    );
    });
  },
} satisfies ExportedHandler<CloudflareEnv>;
