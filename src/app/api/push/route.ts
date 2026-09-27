import { getCloudflareContext } from "@opennextjs/cloudflare";
import { apiUser, rateLimit, smallJson } from "@/lib/api-security";
import { all, one, run, scalar } from "@/lib/db";
import { validateSubscription } from "@/lib/push-rules";
import { explicaFalha, sanitizeError, webPushSender } from "@/lib/push-scheduler";

export async function GET(request: Request) {
  const user = await apiUser(request);
  if (!user) return Response.json({ error: "Entre novamente." }, { status: 401 });
  const env = getCloudflareContext().env;
  const devices = await all("SELECT id,label,enabled,created_at,last_success_at,last_error FROM push_subscriptions WHERE user_id=? ORDER BY id DESC",[user.id]);
  // Diagnostico: o que o servidor sabe. O que so o aparelho sabe (serviceWorker,
  // permissao, subscription local) e checado no proprio navegador.
  const ultimoCiclo = await one<{value:string}>("SELECT value FROM scheduler_state WHERE key='last_run'");
  const ultimoEnvio = await one<{sent_at:number}>(
    "SELECT MAX(d.sent_at) AS sent_at FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id WHERE s.user_id=? AND d.status='sent'",
    [user.id],
  );
  const ultimaFalha = await one<{last_error:string}>(
    `SELECT d.last_error FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id
      WHERE s.user_id=? AND d.last_error IS NOT NULL ORDER BY d.id DESC LIMIT 1`,
    [user.id],
  );
  const pendentes = await scalar<number>(
    `SELECT COUNT(*) FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id
      WHERE s.user_id=? AND d.status IN ('pending','sending')`,
    [user.id],
  );
  const pushLigado = await one<{value:string}>("SELECT value FROM settings WHERE key='push_enabled'");
  return Response.json({
    devices,
    publicKey: env.VAPID_PUBLIC_KEY || "",
    userId: user.id,
    diagnostico: {
      vapidConfigurado: !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      pushLigado: pushLigado?.value !== "0",
      ultimoCicloAgendador: ultimoCiclo ? Number(ultimoCiclo.value) : null,
      ultimoEnvioComSucesso: ultimoEnvio?.sent_at ?? null,
      ultimaFalha: ultimaFalha?.last_error ?? null,
      naFila: pendentes,
    },
  }, { headers:{ "Cache-Control":"no-store" } });
}
export async function POST(request: Request) {
  const user = await apiUser(request,true);
  if (!user) return Response.json({ error: "Sessão expirada ou origem inválida." }, { status:401 });
  try {
    if (!await rateLimit(`push:${user.id}`,20)) return Response.json({error:"Aguarde um minuto."},{status:429});
    const input = await smallJson(request);
    if (input.action === "disable") {
      await run("UPDATE push_subscriptions SET enabled=0,updated_at=unixepoch() WHERE user_id=? AND id=?",[user.id,Number(input.id)]);
      return Response.json({ok:true});
    }
    if (input.action === "test") {
      const env = getCloudflareContext().env;
      if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error("Servidor sem chaves VAPID configuradas.");
      const device = await one<{id:number;endpoint:string;p256dh:string;auth:string}>(
        "SELECT id,endpoint,p256dh,auth FROM push_subscriptions WHERE id=? AND user_id=? AND enabled=1",
        [Number(input.id), user.id],
      );
      if (!device) throw new Error("Dispositivo não encontrado ou desativado.");
      // Push real, so para este aparelho. O resultado volta cru para a tela:
      // e ele que diz se o problema e credencial, rede ou o servico do fabricante.
      const sender = webPushSender({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT });
      let status = 0;
      let falha = "";
      try {
        status = await sender(
          { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
          { id: `teste-${Date.now()}`, title: "Teste de Notificação", body: "Se você recebeu esta mensagem, o push está funcionando corretamente.", url: "/notificacoes" },
        );
      } catch (e) {
        falha = sanitizeError(e);
      }
      const ok = status >= 200 && status < 300;
      await run(
        "UPDATE push_subscriptions SET last_success_at=CASE WHEN ? THEN unixepoch() ELSE last_success_at END,last_error=? WHERE id=?",
        [ok ? 1 : 0, ok ? null : explicaFalha(status, falha), device.id],
      );
      return Response.json({ ok, status, error: ok ? null : explicaFalha(status, falha), detalhe: falha || null });
    }
    if (input.action !== "subscribe") throw new Error("Ação inválida.");
    const s = validateSubscription(input.subscription);
    const existing = await one<{id:number;user_id:number}>("SELECT id,user_id FROM push_subscriptions WHERE endpoint=?",[s.endpoint]);
    if (existing && existing.user_id!==user.id) return Response.json({error:"Este navegador está inscrito em outra conta. Remova a inscrição local e ative novamente.",resetLocal:true},{status:409});
    if (!existing && await scalar<number>("SELECT COUNT(*) FROM push_subscriptions WHERE user_id=?",[user.id])>=20) throw new Error("Limite de 20 dispositivos por usuário.");
    const expires = input.subscription.expirationTime;
    if (expires != null && (!Number.isFinite(expires) || expires <= Date.now())) throw new Error("Inscrição expirada. Ative novamente.");
    const label = String(input.label ?? "Meu dispositivo").trim().slice(0,80) || "Meu dispositivo";
    await run(`INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,label,expiration_time) VALUES (?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth,label=excluded.label,expiration_time=excluded.expiration_time,enabled=1,updated_at=unixepoch(),last_error=NULL
      WHERE push_subscriptions.user_id=excluded.user_id`,[user.id,s.endpoint,s.p256dh,s.auth,label,expires??null]);
    return Response.json({ok:true});
  } catch(e) { return Response.json({error:e instanceof Error?e.message:"Falha ao salvar dispositivo."},{status:400}); }
}
