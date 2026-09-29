import { requirePlatformAdmin } from "@/lib/auth";
import { listarEmpresasPainel, metricasPainel, STATUS_ROTULO, type SubscriptionStatus } from "@/lib/billing";
import { asaasEnvironment } from "@/lib/asaas";
import { PageHeader, Card, Badge, Empty } from "@/components/ui";
import AcoesEmpresa from "./AcoesEmpresa";

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

export default async function SaasAdminPage() {
  await requirePlatformAdmin();
  const [empresas, m, env] = await Promise.all([
    listarEmpresasPainel(),
    metricasPainel(),
    asaasEnvironment(),
  ]);

  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader
        title="Painel do SaaS"
        subtitle={`Visão da plataforma · Asaas: ${env === "nao_configurado" ? "não configurado" : env}`}
        action={
          <a href="/dashboard" className="rounded-xl border border-stone-300 px-3 py-2 text-sm font-semibold text-stone-700 hover:bg-stone-50">
            Voltar ao sistema
          </a>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ["MRR", money(m.mrr)],
          ["Ativas", String(m.ativas)],
          ["Em trial", String(m.trials)],
          ["Suspensas", String(m.suspensas)],
          ["Empresas", String(m.empresas)],
        ].map(([rotulo, valor]) => (
          <Card key={rotulo} className="text-center">
            <div className="text-xs font-bold uppercase tracking-wide text-stone-500">{rotulo}</div>
            <div className="mt-1 text-xl font-black text-tinta-900">{valor}</div>
          </Card>
        ))}
      </div>

      <Card>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Empresas e assinaturas</h2>
        {empresas.length === 0 ? (
          <Empty>Nenhuma empresa cadastrada.</Empty>
        ) : (
          <div className="divide-y divide-stone-100">
            {empresas.map((e) => (
              <div key={e.company_id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-40">
                  <div className="font-semibold text-tinta-900">
                    {e.name} {!e.active && <span className="text-xs text-stone-400">(inativa)</span>}
                  </div>
                  <div className="text-xs text-stone-500">
                    {e.usuarios} usuário{e.usuarios === 1 ? "" : "s"}
                    {e.plano ? ` · ${e.plano} (${money(e.price_cents)}/mês)` : " · sem assinatura"}
                  </div>
                </div>
                <div className="text-xs text-stone-500">
                  {e.status === "trial" && <>trial até {dataBR(e.trial_ends_at)}</>}
                  {(e.status === "active" || e.status === "past_due") && <>período até {dataBR(e.current_period_end)}</>}
                  {(e.status === "suspended" || e.status === "canceled") && <>acesso bloqueado</>}
                  {!e.status && <>primeiro acesso criará o trial</>}
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
