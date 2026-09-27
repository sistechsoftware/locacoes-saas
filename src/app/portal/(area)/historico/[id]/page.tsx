import Link from "next/link";
import { notFound } from "next/navigation";
import { requireCliente } from "@/lib/portal-auth";
import { reservaDoCliente } from "@/lib/portal";
import { dateBR, dateTimeBR, money, timeBR } from "@/lib/format";
import { statusDef, RESERVATION_STATUS, OPERATION_STATUS } from "@/lib/domain";
import { PAYMENT_METHOD_LABEL } from "@/lib/domain";

export const dynamic = "force-dynamic";

/**
 * Detalhes de uma locacao, do ponto de vista do cliente.
 *
 * O id vem da URL, mas a AUTORIZACAO vem da sessao: reservaDoCliente so
 * devolve a reserva se ela pertencer ao cliente logado. Id de outro cliente,
 * id invalido ou id manipulado viram 404 — indistinguivel de nao-existir.
 */
export default async function PortalReservaPage({ params }: { params: Promise<{ id: string }> }) {
  const cliente = await requireCliente();
  const { id } = await params;
  const reservaId = Number(id);
  if (!Number.isInteger(reservaId) || reservaId <= 0) notFound();

  const dados = await reservaDoCliente(cliente.id, reservaId);
  if (!dados) notFound();
  const { reserva: r, itens, financeiro, operacoes } = dados;

  const st = statusDef(RESERVATION_STATUS, r.status);

  return (
    <div className="space-y-4">
      <Link href="/portal/historico" className="inline-flex items-center gap-1 text-sm font-semibold text-marca-600">
        ← Voltar para minhas locações
      </Link>

      <header className="cartao p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Reserva {r.number}</p>
            <h1 className="mt-0.5 text-xl font-black text-tinta-900">
              {dateBR(r.event_date)}
              {r.event_time ? ` · ${timeBR(r.event_time)}` : ""}
            </h1>
            {(r.address || r.district || r.city) && (
              <p className="mt-0.5 text-sm text-stone-600">
                📍 {[r.address, r.district, r.city].filter(Boolean).join(", ")}
              </p>
            )}
          </div>
          <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${TOM(st.tone)}`}>{st.label}</span>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {r.contou_fidelidade && (
            <span className="rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700">
              🎁 contou no programa de fidelidade
            </span>
          )}
          {r.usou_recompensa && (
            <span className="rounded-full border border-destaque-300 bg-destaque-100 px-2 py-0.5 text-xs font-semibold text-destaque-700">
              🎫 usou recompensa de fidelidade
            </span>
          )}
        </div>
      </header>

      <section className="cartao p-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-stone-600">O que você contratou</h2>
        <ul className="mt-2 divide-y divide-nuvem-200">
          {itens.map((i) => (
            <li key={`${i.name}-${i.qty}`} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span className="min-w-0">
                <b className="text-tinta-900">{i.qty}x</b> {i.name}
              </span>
              <span className="shrink-0 font-semibold text-tinta-900">{money(i.subtotal)}</span>
            </li>
          ))}
          {itens.length === 0 && <li className="py-2 text-sm text-stone-500">Itens não detalhados nesta reserva.</li>}
        </ul>
      </section>

      <section className="cartao p-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-stone-600">Valores</h2>
        <div className="mt-2 space-y-1.5 text-sm">
          <Linha rotulo="Total da locação" valor={money(financeiro.total)} destaque />
          <Linha rotulo="Já pago" valor={money(financeiro.paid)} verde />
          <Linha rotulo="Saldo" valor={money(financeiro.balance)} vermelho={financeiro.balance > 0} />
        </div>
      </section>

      {operacoes.length > 0 && (
        <section className="cartao p-4">
          <h2 className="text-sm font-bold uppercase tracking-wide text-stone-600">Entrega e retirada</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {operacoes.map((o, idx) => {
              const os = statusDef(OPERATION_STATUS, o.status);
              return (
                <li key={idx} className="flex items-center justify-between gap-3">
                  <span className="text-stone-600">
                    {ROTULO_OP[o.kind] ?? o.kind} · {dateTimeBR(o.scheduled_at)}
                  </span>
                  <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${TOM(os.tone)}`}>
                    {os.label}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <p className="text-center text-xs text-stone-500">
        Dúvidas sobre valores? Fale com a gente pelo WhatsApp — os contatos estão na página inicial.
      </p>
    </div>
  );
}

function Linha({
  rotulo,
  valor,
  destaque,
  verde,
  vermelho,
}: {
  rotulo: string;
  valor: string;
  destaque?: boolean;
  verde?: boolean;
  vermelho?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-stone-500">{rotulo}</span>
      <span
        className={`font-bold ${
          vermelho ? "text-red-600" : verde ? "text-emerald-600" : destaque ? "text-tinta-900" : "text-tinta-700"
        } ${destaque ? "text-base" : ""}`}
      >
        {valor}
      </span>
    </div>
  );
}

const ROTULO_OP: Record<string, string> = {
  entrega: "🚚 Entrega",
  retirada: "🔄 Retirada",
  montagem: "🛠️ Montagem",
  desmontagem: "🧰 Desmontagem",
};

function TOM(tone: string): string {
  const map: Record<string, string> = {
    cinza: "bg-stone-100 text-stone-700 border-stone-300",
    ambar: "bg-amber-50 text-amber-800 border-amber-300",
    verde: "bg-emerald-50 text-emerald-800 border-emerald-300",
    azul: "bg-sky-50 text-sky-800 border-sky-300",
    roxo: "bg-violet-50 text-violet-800 border-violet-300",
    vermelho: "bg-red-50 text-red-800 border-red-300",
    terracota: "bg-destaque-100 text-destaque-700 border-destaque-300",
  };
  return map[tone] ?? map.cinza;
}
