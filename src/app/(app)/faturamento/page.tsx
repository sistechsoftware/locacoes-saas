import { requireModule } from "@/lib/auth";
import { estadoAssinatura, listarPlanos, STATUS_ROTULO, assinaturaDaEmpresa } from "@/lib/billing";
import { all } from "@/lib/db";
import { PageHeader, Card, Badge, Empty } from "@/components/ui";
import GerarCobrancaButton from "./GerarCobrancaButton";
import TrocarPlanoButtons from "./TrocarPlanoButtons";

export const dynamic = "force-dynamic";

function money(centavos: number) {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dataBR(iso: string | null) {
  return iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—";
}

const TONE: Record<string, string> = {
  trial: "bg-amber-100 text-amber-800",
  active: "bg-green-100 text-green-800",
  past_due: "bg-orange-100 text-orange-800",
  suspended: "bg-red-100 text-red-800",
  canceled: "bg-stone-200 text-stone-700",
};

export default async function FaturamentoPage() {
  const { user } = await requireModule("assinatura");
  const estado = await estadoAssinatura(user.company_id);
  const planos = await listarPlanos();
  const sub = await assinaturaDaEmpresa(user.company_id);
  const cobrancas = await all<any>(
    `SELECT amount_cents, status, due_date, paid_at, invoice_url, billing_type
       FROM subscription_payments WHERE company_id = ? ORDER BY id DESC LIMIT 12`,
    [user.company_id],
  );

  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader
        title="Assinatura"
        subtitle="Plano, período vigente e cobranças da sua empresa."
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${TONE[estado.status] ?? "bg-stone-100"}`}>
                {estado.rotulo}
              </span>
              {estado.plano && <span className="text-sm font-semibold text-tinta-900">{estado.plano.name}</span>}
            </div>
            <p className="mt-2 text-sm text-stone-600">
              {estado.status === "trial" && estado.trial_ends_at && (
                <>Avaliação até <b>{dataBR(estado.trial_ends_at)}</b> ({estado.diasRestantes} dia{estado.diasRestantes === 1 ? "" : "s"} restantes).</>
              )}
              {estado.status === "active" && (
                <>Período vigente até <b>{dataBR(estado.current_period_end)}</b>.</>
              )}
              {estado.status === "past_due" && (
                <>Existe cobrança em aberto. Regularize para evitar o bloqueio.</>
              )}
              {(estado.status === "suspended" || estado.status === "canceled") && (
                <>Acesso bloqueado. Regularize o pagamento ou fale com a plataforma.</>
              )}
            </p>
            {estado.avisoVencimento && (
              <p className="mt-1 text-xs font-medium text-amber-700">
                Vence em {estado.diasRestantes} dia{estado.diasRestantes === 1 ? "" : "s"} — gere a cobrança abaixo para renovar.
              </p>
            )}
          </div>
          {estado.plano && (
            <div className="text-right">
              <div className="text-2xl font-black text-tinta-900">{money(estado.plano.price_cents)}</div>
              <div className="text-xs text-stone-500">por mês · até {estado.plano.max_users} usuários</div>
            </div>
          )}
        </div>
        {user.role === "owner" && <GerarCobrancaButton />}
      </Card>

      {user.role === "owner" && (
        <Card className="mb-4">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Planos disponíveis</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {planos.map((p) => {
              const atual = sub?.plan_id === p.id;
              return (
                <div key={p.id} className={`rounded-2xl border p-4 ${atual ? "border-marca-500 bg-marca-50" : "border-stone-200"}`}>
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-tinta-900">{p.name}</h3>
                    {atual && <Badge tone="verde">atual</Badge>}
                  </div>
                  <div className="mt-1 text-xl font-black text-tinta-900">{money(p.price_cents)}</div>
                  <p className="mt-1 min-h-10 text-xs text-stone-500">{p.description}</p>
                  <p className="mt-1 text-xs text-stone-400">até {p.max_users} usuários</p>
                  {!atual && user.role === "owner" && <TrocarPlanoButtons slug={p.slug} />}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <Card>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Histórico de cobranças</h2>
        {cobrancas.length === 0 ? (
          <Empty>Nenhuma cobrança gerada ainda.</Empty>
        ) : (
          <div className="divide-y divide-stone-100">
            {cobrancas.map((c, i) => (
              <div key={i} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                <div>
                  <span className="font-semibold text-tinta-900">{money(c.amount_cents)}</span>
                  <span className="text-stone-500"> · venc. {dataBR(c.due_date)}</span>
                  {c.paid_at && <span className="text-stone-500"> · pago {dataBR(c.paid_at)}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={c.status === "received" || c.status === "confirmed" ? "verde" : c.status === "pending" ? "ambar" : c.status === "overdue" ? "vermelho" : "cinza"}>
                    {c.status}
                  </Badge>
                  {c.invoice_url && (
                    <a href={c.invoice_url} target="_blank" rel="noreferrer" className="text-marca-600 underline">
                      fatura
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
