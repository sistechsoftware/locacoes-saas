// @ts-ignore OpenNext generates this module during the deployment build.
import handler from "./.open-next/worker.js";
import { runWithDb } from "./src/lib/db";
import { runNotificationScheduler, webPushSender } from "./src/lib/push-scheduler";
import { runBirthdayDaily, runFidelityDaily } from "./src/lib/fidelidade-cron";
import { mensagemDeErro, podarErrosAntigos, registrarErro } from "./src/lib/error-log";

export default {
  fetch: handler.fetch,
  async scheduled(event, env, ctx) {
    // Toda rotina registra a propria falha: sem isso, uma quebra fica invisivel
    // e a rotina simplesmente para de acontecer. O diario error_logs guarda
    // cada falha com o dia em que ocorreu (fonte "cron"), visivel em /erros.
    ctx.waitUntil(
      runNotificationScheduler(env.DB, Math.floor(event.scheduledTime / 1000),
        env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
          ? webPushSender({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT })
          : undefined,
      )
        .then((result) => { console.log(JSON.stringify({ event: "notification_cron", ...result })); })
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
    // fidelidade uma vez por dia: expirar recompensas e preparar lembretes nao
    // pode depender de alguem abrir o sistema
    ctx.waitUntil(runFidelityDaily(env.DB, Math.floor(event.scheduledTime / 1000))
      .then((result) => { if (result) console.log(JSON.stringify({ event: "fidelity_cron", ...result })); })
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
      }));
    // aniversarios: uma falha aqui nao pode derrubar as outras rotinas do cron
    ctx.waitUntil(runBirthdayDaily(env.DB, Math.floor(event.scheduledTime / 1000))
      .then((result) => { if (result) console.log(JSON.stringify({ event: "birthday_cron", ...result })); })
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
      }));
    // manutencao do proprio diario: nada de erro cresce para sempre (30 dias)
    ctx.waitUntil(podarErrosAntigos(env.DB).catch(() => {}));
  },
} satisfies ExportedHandler<CloudflareEnv>;
