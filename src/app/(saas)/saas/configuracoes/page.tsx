import { requirePlatformAdmin } from "@/lib/auth";
import { asaasEnvironment } from "@/lib/asaas";
import { credenciaisAsaas } from "@/lib/platform-settings";
import { emailEstado, type MotivoEmail } from "@/lib/email";
import { Card } from "@/components/ui";
import FormAsaas, { type EstadoIntegracao } from "./FormAsaas";

export const dynamic = "force-dynamic";

/**
 * Estado das integrações da plataforma. Os segredos nunca são exibidos —
 * apenas se estão configurados e em qual ambiente (sandbox/produção).
 */

/** URL pública da plataforma — base para montar a URL do webhook no formulário. */
async function publicUrlPlataforma(): Promise<string> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    return getCloudflareContext().env.PUBLIC_URL ?? "";
  } catch {
    return "";
  }
}

const ESTADO_EMAIL: Record<"ok" | MotivoEmail, { cor: string; texto: string }> = {
  ok: { cor: "text-green-700", texto: "configurado — envios ativos" },
  sem_api_key: { cor: "text-red-700", texto: "RESEND_API_KEY ausente — e-mails desabilitados" },
  sem_remetente: {
    cor: "text-red-700",
    texto: "RESEND_FROM ausente — remetente padrão resend.dev foi removido; envio pulado (falha registrada em /erros)",
  },
  remetente_dev: {
    cor: "text-red-700",
    texto: "RESEND_FROM no domínio de teste resend.dev — configure um domínio próprio verificado (falha registrada em /erros)",
  },
  sem_contexto: {
    cor: "text-amber-700",
    texto: "contexto do Worker indisponível nesta execução — secrets ilegíveis (falha registrada em /erros)",
  },
};

export default async function SaasConfiguracoesPage() {
  // Guard redundante ao layout (ver nota em saas/page.tsx).
  await requirePlatformAdmin();
  const asaas = await asaasEnvironment();
  const cred = await credenciaisAsaas();
  const email = ESTADO_EMAIL[await emailEstado()];

  const estado: EstadoIntegracao = {
    ambiente: cred.environment,
    temApiKey: !!cred.apiKey,
    temToken: !!cred.webhookToken,
    origem: cred.origem,
    publicUrl: await publicUrlPlataforma(),
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-tinta-900">Integrações</h1>
        <p className="text-sm text-stone-500">Estado das conexões da plataforma com serviços externos.</p>
      </div>

      <Card>
        <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Asaas (cobrança PIX)</h2>
        <div className="mt-3 space-y-1 text-sm">
          <p>
            <span className="font-semibold text-tinta-900">Estado:</span>{" "}
            {asaas === "nao_configurado" ? (
              <span className="text-red-700">não configurado — cobranças desabilitadas</span>
            ) : asaas === "sandbox" ? (
              <span className="text-amber-700">sandbox (pagamentos simulados)</span>
            ) : (
              <span className="text-green-700">produção</span>
            )}
          </p>
          <p className="text-xs text-stone-500">
            Chave e ambiente vêm do secret do Worker (ASAAS_API_KEY / ASAAS_ENVIRONMENT) ou, na falta, do cadastro
            abaixo — o Worker tem prioridade. Webhook:{" "}
            <code className="rounded bg-stone-100 px-1">/api/webhooks/asaas?token=…</code> (ASAAS_WEBHOOK_TOKEN ou
            token cadastrado aqui).
          </p>
          <FormAsaas estado={estado} />
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Resend (e-mail transacional)</h2>
        <div className="mt-3 space-y-1 text-sm">
          <p>
            <span className="font-semibold text-tinta-900">Estado:</span>{" "}
            <span className={email.cor}>{email.texto}</span>
          </p>
          <p className="text-xs text-stone-500">
            Segredo no Worker (<code className="rounded bg-stone-100 px-1">RESEND_API_KEY</code>) · remetente{" "}
            <code className="rounded bg-stone-100 px-1">RESEND_FROM</code> com domínio verificado no Resend (sem fallback para
            resend.dev). Falhas de envio nunca derrubam o fluxo (fail-open por design), mas ficam visíveis em{" "}
            <code className="rounded bg-stone-100 px-1">/erros</code>.
          </p>
        </div>
      </Card>
    </div>
  );
}
