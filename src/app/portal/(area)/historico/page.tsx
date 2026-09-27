import Link from "next/link";
import { requireCliente } from "@/lib/portal-auth";
import { reservasDoCliente, financeiroDoCliente } from "@/lib/portal";
import { dateBR, money, timeBR } from "@/lib/format";
import { statusDef, RESERVATION_STATUS } from "@/lib/domain";

export const dynamic = "force-dynamic";

const ROTULO = (status: string) => statusDef(RESERVATION_STATUS, status).label;

/**
 * Historico de locacoes do cliente.
 *
 * Cada linha mostra o que interessa ao cliente — quando foi, o que contratou,
 * quanto custou, se contou para o fidelidade — sem expor nada interno
 * (estoque fisico, notas da equipe, custos).
 */
export default async function PortalHistorico() {
  const cliente = await requireCliente();
  const [reservas, financeiro] = await Promise.all([
    reservasDoCliente(cliente.id),
    financeiroDoCliente(cliente.id),
  ]);

  const ativas = reservas.filter((r) => !["cancelada", "finalizada", "retirada"].includes(r.status));

  return (
    <div className="space-y-4">
      <header>
        <h1 className="text-xl font-black text-tinta-900">Minhas locações</h1>
        <p className="text-sm text-stone-500">
          {reservas.length} reserva(s) no histórico · {financeiro.locacoes_concluidas} concluída(s)
        </p>
      </header>

      {ativas.length > 0 && (
        <section>
          <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-500">Em andamento / futuras</h2>
          <div className="space-y-2">
            {ativas.map((r) => (
              <ReservaRow key={r.id} r={r} />
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-500">Histórico completo</h2>
        {reservas.length === 0 ? (
          <p className="rounded-xl border border-dashed border-nuvem-300 bg-nuvem-50 px-4 py-8 text-center text-sm text-stone-500">
            Você ainda não possui locações. Fale com a gente para fazer a primeira! 💬
          </p>
        ) : (
          <div className="space-y-2">
            {reservas.map((r) => (
              <ReservaRow key={r.id} r={r} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function ReservaRow({ r }: { r: Reserva }) {
  const futuro = r.event_date >= new Date().toISOString().slice(0, 10) && !["cancelada", "finalizada", "retirada"].includes(r.status);
  return (
    <Link href={`/portal/historico/${r.id}`} className="block cartao p-3.5 transition hover:border-marca-300">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-bold text-tinta-900">{dateBR(r.event_date)}</span>
            {r.event_time ? (
              <span className="text-xs text-stone-500">
                {timeBR(r.event_time)}
                {r.pickup_at ? ` · retirada ${timeBR(r.pickup_at)}` : ""}
              </span>
            ) : null}
          </p>
          <p className="mt-0.5 truncate text-xs text-stone-500">
            Reserva {r.number}
            {(r.address || r.district || r.city) &&
              ` · ${[r.address, r.district, r.city].filter(Boolean).join(", ")}`}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${COR[r.status] ?? COR._padrao}`}>
              {ROTULO(r.status)}
            </span>
            {r.contou_fidelidade && (
              <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                🎁 contou no fidelidade
              </span>
            )}
            {r.usou_recompensa && (
              <span className="rounded-full border border-destaque-300 bg-destaque-100 px-2 py-0.5 text-xs font-semibold text-destaque-700">
                🎫 usou recompensa
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-bold text-tinta-900">{money(r.total_cents)}</p>
          {r.total_cents - r.paid_cents > 0 && r.status !== "cancelada" && (
            <p className="text-xs font-semibold text-red-600">saldo {money(r.total_cents - r.paid_cents)}</p>
          )}
          {r.status !== "cancelada" && r.total_cents - r.paid_cents <= 0 && r.total_cents > 0 && (
            <p className="text-xs font-semibold text-emerald-600">pago</p>
          )}
        </div>
      </div>
      {futuro && <p className="sr-only">Reserva futura</p>}
    </Link>
  );
}

const COR: Record<string, string> = {
  orcamento: "bg-stone-100 text-stone-700 border-stone-300",
  pre_reserva: "bg-amber-50 text-amber-800 border-amber-300",
  confirmada: "bg-emerald-50 text-emerald-800 border-emerald-300",
  entregue: "bg-sky-50 text-sky-800 border-sky-300",
  em_uso: "bg-violet-50 text-violet-800 border-violet-300",
  aguardando_retirada: "bg-amber-50 text-amber-800 border-amber-300",
  retirada: "bg-sky-50 text-sky-800 border-sky-300",
  finalizada: "bg-stone-100 text-stone-700 border-stone-300",
  cancelada: "bg-red-50 text-red-800 border-red-300",
  _padrao: "bg-stone-100 text-stone-700 border-stone-300",
};

type Reserva = Awaited<ReturnType<typeof reservasDoCliente>>[number];
