import { requirePlatformAdmin } from "@/lib/auth";
import { listarEmpresasPainel, STATUS_ROTULO, type SubscriptionStatus } from "@/lib/billing";
import { Card, Badge, Empty } from "@/components/ui";
import AcoesEmpresa from "../AcoesEmpresa";

export const dynamic = "force-dynamic";

function money(centavos: number | null) {
  if (centavos === null) return "—";
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

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

/** Todos os clientes da plataforma, com contato, assinatura e ações. */
export default async function SaasEmpresasPage() {
  // Guard redundante ao layout (ver nota em saas/page.tsx): impede consulta
  // e emissão de dados para quem não é platform_admin.
  await requirePlatformAdmin();
  const empresas = await listarEmpresasPainel();

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-tinta-900">Empresas clientes</h1>
        <p className="text-sm text-stone-500">
          {empresas.length} empresa{empresas.length === 1 ? "" : "s"} cadastrada{empresas.length === 1 ? "" : "s"} na plataforma.
        </p>
      </div>

      <Card>
        {empresas.length === 0 ? (
          <Empty>Nenhuma empresa cadastrada.</Empty>
        ) : (
          <div className="divide-y divide-stone-100">
            {empresas.map((e) => (
              <div key={e.company_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-48">
                  <div className="font-semibold text-tinta-900">
                    #{e.company_id} · {e.name} {!e.active && <span className="text-xs text-stone-400">(inativa)</span>}
                  </div>
                  <div className="text-xs text-stone-500">
                    {e.usuarios} usuário{e.usuarios === 1 ? "" : "s"}
                    {e.owner_email && <> · {e.owner_email}</>}
                  </div>
                </div>
                <div className="text-xs text-stone-500">
                  {e.status === "trial" && <>trial até {dataBR(e.trial_ends_at)}</>}
                  {(e.status === "active" || e.status === "past_due") && <>período até {dataBR(e.current_period_end)}</>}
                  {(e.status === "suspended" || e.status === "canceled") && <>acesso bloqueado</>}
                  {!e.status && <>primeiro acesso criará o trial</>}
                  {e.plano && <> · {e.plano} ({money(e.price_cents)}/mês)</>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={TONE[e.status ?? "sem"]}>{e.status ? STATUS_ROTULO[e.status] : "novo"}</Badge>
                  <AcoesEmpresa companyId={e.company_id} />
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
