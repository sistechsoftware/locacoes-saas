import Link from "next/link";
import { Badge, StatusBadge } from "./ui";
import { Icon } from "./Icons";
import { FREIGHT_STATUS } from "@/lib/domain";
import { mapsLink, phoneBR, timeBR, today, waLink } from "@/lib/format";

/**
 * Cartao do frete na Operacao do dia. Espelha o OperationCard (mesma grade,
 * mesmas acoes de Rota/WhatsApp/Detalhes) para que locacao e frete leiam como
 * operacoes da mesma familia; a cor fuchsia e a mesma que agenda e dashboard
 * ja usam para o tipo "frete". Reuso total: nada aqui muda dados.
 */
export function FreightCard({ f, showDate = false }: { f: any; showDate?: boolean }) {
  const maps = mapsLink(f.destination);
  const wa = waLink(f.whatsapp || f.phone, `Olá, ${f.customer ?? f.contact_name ?? ""}!`);
  // Mesmo criterio do OperationCard: data passada e ainda sem execucao final.
  const late = f.date < today() && f.status !== "concluido" && f.status !== "cancelado";

  return (
    <div className="cartao overflow-hidden">
      <Link href={`/fretes/${f.id}`} className="block p-3">
        <div className="flex items-start gap-3">
          <div className="flex w-14 shrink-0 flex-col items-center justify-center gap-1 rounded-xl bg-nuvem-100 py-2">
            <span className="text-base leading-none">🚛</span>
            <span className="mt-1 text-sm font-bold leading-none text-tinta-900">
              {timeBR(f.time) !== "-" ? timeBR(f.time) : "Dia todo"}
            </span>
            {showDate && (
              <span className="mt-0.5 text-[0.6rem] text-stone-500">
                {f.date.slice(8, 10)}/{f.date.slice(5, 7)}
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="roxo">Frete</Badge>
              <StatusBadge defs={FREIGHT_STATUS} value={f.status} />
              {late && <Badge tone="vermelho">Atrasada</Badge>}
            </div>
            <p className="mt-1 truncate text-sm font-bold text-tinta-900">
              {f.customer ?? f.contact_name ?? "Sem cliente"}
            </p>
            {f.cargo && <p className="truncate text-xs text-stone-600">{f.cargo}</p>}
            <p className="truncate text-xs text-stone-500">
              {[f.origin, f.destination].filter(Boolean).join(" até ") || "Trajeto não informado"}
            </p>
            <p className="mt-0.5 text-xs text-stone-400">
              {f.number}
              {f.phone ? ` · ${phoneBR(f.phone)}` : ""}
              {f.notes ? ` · ${f.notes}` : ""}
            </p>
          </div>
        </div>
      </Link>

      <div className="flex gap-1 border-t border-nuvem-200 bg-nuvem-50 px-2 py-1.5">
        {maps && (
          <a
            href={maps}
            target="_blank"
            rel="noreferrer"
            className="flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-tinta-700 hover:bg-white"
          >
            <Icon name="operacao" className="h-4 w-4" /> Rota
          </a>
        )}
        {wa && (
          <a
            href={wa}
            target="_blank"
            rel="noreferrer"
            className="flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-white"
          >
            <Icon name="whatsapp" className="h-4 w-4" /> WhatsApp
          </a>
        )}
        <Link
          href={`/fretes/${f.id}`}
          className="flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-marca-600 hover:bg-white"
        >
          <Icon name="ok" className="h-4 w-4" /> Detalhes
        </Link>
      </div>
    </div>
  );
}
