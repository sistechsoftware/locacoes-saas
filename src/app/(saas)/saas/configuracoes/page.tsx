import { requirePlatformAdmin } from "@/lib/auth";
import { asaasEnvironment } from "@/lib/asaas";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Estado das integrações da plataforma. Os segredos nunca são exibidos —
 * apenas se estão configurados e em qual ambiente (sandbox/produção).
 */
export default async function SaasConfiguracoesPage() {
  // Guard redundante ao layout (ver nota em saas/page.tsx).
  await requirePlatformAdmin();
  const asaas = await asaasEnvironment();

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
            Chave e ambiente vêm dos secrets do Worker (ASAAS_API_KEY / ASAAS_ENVIRONMENT). Webhook:{" "}
            <code className="rounded bg-stone-100 px-1">/api/webhooks/asaas?token=…</code> (ASAAS_WEBHOOK_TOKEN).
          </p>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Resend (e-mail transacional)</h2>
        <div className="mt-3 space-y-1 text-sm">
          <p>
            <span className="font-semibold text-tinta-900">Estado:</span> segredo no Worker (
            <code className="rounded bg-stone-100 px-1">RESEND_API_KEY</code>) · remetente{" "}
            <code className="rounded bg-stone-100 px-1">RESEND_FROM</code>. Falhas de envio nunca derrubam o fluxo
            (fail-open por design).
          </p>
        </div>
      </Card>
    </div>
  );
}
