import { requirePlatformAdmin } from "@/lib/auth";
import { listarEventosWebhookPainel } from "@/lib/billing";
import { Card, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

function dataHoraBR(sql: string | null) {
  if (!sql) return "—";
  const [dia, hora] = sql.slice(0, 16).split(" ");
  return `${dia.split("-").reverse().join("/")}${hora ? ` ${hora}` : ""}`;
}

/** Trilha completa de eventos recebidos do webhook do Asaas. */
export default async function SaasEventosPage() {
  // Guard redundante ao layout (ver nota em saas/page.tsx).
  await requirePlatformAdmin();
  const eventos = await listarEventosWebhookPainel(100);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-tinta-900">Eventos do Asaas</h1>
        <p className="text-sm text-stone-500">
          Últimos {eventos.length} eventos recebidos no webhook — idempotência por SHA-256 do corpo.
        </p>
      </div>

      <Card>
        {eventos.length === 0 ? (
          <Empty>Nenhum evento recebido ainda.</Empty>
        ) : (
          <div className="divide-y divide-stone-100">
            {eventos.map((e) => (
              <div key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="font-mono text-xs font-bold text-tinta-900">#{e.id} {e.event}</div>
                <div className="text-xs text-stone-500">{dataHoraBR(e.created_at)}</div>
                <div className="text-xs">
                  {e.handled ? (
                    <span className="font-semibold text-green-700">processado</span>
                  ) : (
                    <span className="font-semibold text-red-700">falhou</span>
                  )}
                  {e.error && <span className="ml-1 text-stone-500">({e.error})</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
