// @ts-ignore OpenNext generates this module during the deployment build.
import handler from "./.open-next/worker.js";
import { runWithDb } from "./src/lib/db";
import { runNotificationScheduler, webPushSender } from "./src/lib/push-scheduler";
import { runBirthdayDaily, runFidelityDaily, paraCadaEmpresa } from "./src/lib/fidelidade-cron";
import { mensagemDeErro, podarErrosAntigos, registrarErro } from "./src/lib/error-log";

export default {
  fetch: handler.fetch,
  async scheduled(event, env, ctx) {
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
    ctx.waitUntil(
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
              context: { rotina: "runNotificationScheduler" },
            }),
          );
        }),
    );
    // fidelidade uma vez por dia, POR EMPRESA: expirar recompensas e preparar
    // lembretes nao pode depender de alguem abrir o sistema
    ctx.waitUntil(
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
              context: { rotina: "runFidelityDaily" },
            }),
          );
        }),
    );
    // aniversarios: uma falha aqui (ou numa empresa) nao derruba as outras rotinas
    ctx.waitUntil(
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
              context: { rotina: "runBirthdayDaily" },
            }),
          );
        }),
    );
    // Camada comercial (Etapa 3): trial/periodo/inadimplencia — PLATAFORMA,
    // uma vez por dia (marca global, nao por empresa). A rotina cobre todas as
    // empresas internamente.
    ctx.waitUntil(
      runWithDb(env.DB, async () => {
        const { rotinaDiariaBilling } = await import("./src/lib/billing");
        const hoje = new Date((now - 10800) * 1000).toISOString().slice(0, 10); // America/Sao_Paulo
        const marca = `billing_last_day`;
        const row = await env.DB.prepare("SELECT value FROM scheduler_state WHERE key = ?").bind(marca).first<{ value: string }>();
        if (row?.value === hoje) return;
        await env.DB
          .prepare("INSERT INTO scheduler_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
          .bind(marca, hoje)
          .run();
        const r = await rotinaDiariaBilling();
        // Etapa 5: tokens de recuperação vencidos saem do banco junto.
        const { limparTokensExpirados } = await import("./src/lib/recuperacao");
        const tokensApagados = await limparTokensExpirados().catch(() => -1);
        console.log(JSON.stringify({ event: "billing_cron", ...r, tokensApagados }));
      })
        .catch((e) => {
          console.error("billing_cron_error:", e);
          return runWithDb(env.DB, () =>
            registrarErro({
              source: "cron", kind: "server",
              message: mensagemDeErro(e),
              route: "cron/billing",
              context: { rotina: "rotinaDiariaBilling" },
            }),
          );
        }),
    );
    // limpezas GLOBAIS, uma unica vez por ciclo (sairam do laco por empresa):
    // cache de rotas e rate limits nao pertencem a nenhuma empresa
    ctx.waitUntil(
      env.DB.batch([
        env.DB.prepare("DELETE FROM route_cache WHERE expires_at<?").bind(now),
        env.DB.prepare("DELETE FROM api_rate_limits WHERE expires_at<?").bind(now),
      ]).catch(() => {}),
    );
    // manutencao do proprio diario: nada de erro cresce para sempre (30 dias)
    ctx.waitUntil(podarErrosAntigos(env.DB).catch(() => {}));
  },
} satisfies ExportedHandler<CloudflareEnv>;
