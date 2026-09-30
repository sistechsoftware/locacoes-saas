import { requirePlatformAdmin } from "@/lib/auth";
import { listarEmpresasPainel, STATUS_ROTULO, type SubscriptionStatus } from "@/lib/billing";
import { Card, Badge, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

function dataBR(iso: string | null) {
  return iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—";
}

const TONE: Record<SubscriptionStatus | "sem", any> = {
  trial: "ambar",
  active: "verde",
  past_due: "terracota",
  suspended: "vermelho",
  canceled: "cinza",
  sem: "cinza",
};

/** Todas as assinaturas da plataforma, ordenadas pelo estado crítico. */
export default async function SaasAssinaturasPage() {
  // Guard redundante ao layout (ver nota em saas/page.tsx).
  await requirePlatformAdmin();
  const empresas = await listarEmpresasPainel();
  const ordem: Record<string, number> = { past_due: 0, suspended: 1, trial: 2, active: 3, canceled: 4 };
  const assinaturas = empresas
    .filter((e) => e.status)
    .sort((a, b) => (ordem[a.status ?? ""] ?? 9) - (ordem[b.status ?? ""] ?? 9));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-tinta-900">Assinaturas</h1>
        <p className="text-sm text-stone-500">Estado comercial de cada empresa — trial, período, bloqueios.</p>
      </div>

      <Card>
        {assinaturas.length === 0 ? (
          <Empty>Nenhuma assinatura ainda.</Empty>
        ) : (
          <div className="divide-y divide-stone-100">
            {assinaturas.map((e) => (
              <div key={e.company_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-48">
                  <div className="font-semibold text-tinta-900">{e.name}</div>
                  <div className="text-xs text-stone-500">{e.plano ?? "sem plano"}</div>
                </div>
                <div className="text-xs text-stone-500">
                  {e.status === "trial" && <>trial até {dataBR(e.trial_ends_at)}</>}
                  {e.status === "active" && <>período até {dataBR(e.current_period_end)}</>}
                  {e.status === "past_due" && <>vencido em {dataBR(e.current_period_end)} — em tolerância</>}
                  {(e.status === "suspended" || e.status === "canceled") && <>bloqueada</>}
                </div>
                <Badge tone={TONE[e.status ?? "sem"]}>{STATUS_ROTULO[e.status as SubscriptionStatus]}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
