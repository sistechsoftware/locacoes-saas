import Link from "next/link";
import { Badge, StatusBadge } from "./ui";
import { Icon } from "./Icons";
import { OPERATION_KINDS, OPERATION_STATUS } from "@/lib/domain";
import { mapsLink, phoneBR, timeBR, waLink } from "@/lib/format";

const KIND = Object.fromEntries(OPERATION_KINDS.map((k) => [k.value, k]));

/** Cartao operacional usado no dashboard, na agenda e na tela de entregas. */
export function OperationCard({ op, showDate = false }: { op: any; showDate?: boolean }) {
  const kind = KIND[op.kind] ?? OPERATION_KINDS[0];
  const endereco = [op.address, op.district, op.city].filter(Boolean).join(", ");
  const maps = mapsLink(op.address, op.district, op.city);
  const wa = waLink(op.whatsapp || op.phone, `Olá, ${op.customer ?? ""}!`);
  const late = op.scheduled_at.slice(0, 10) < new Date().toISOString().slice(0, 10) && op.status !== "concluida";

  return (
    <div className="cartao overflow-hidden">
      <Link href={`/operacao/${op.id}`} className="block p-3">
        <div className="flex items-start gap-3">
          <div className="flex w-14 shrink-0 flex-col items-center justify-center gap-1 rounded-xl bg-nuvem-100 py-2">
            <span className="text-base leading-none">{kind.icon}</span>
            <span className="mt-1 text-sm font-bold leading-none text-tinta-900">
              {timeBR(op.scheduled_at)}
            </span>
            {showDate && (
              <span className="mt-0.5 text-[0.6rem] text-stone-500">
                {op.scheduled_at.slice(8, 10)}/{op.scheduled_at.slice(5, 7)}
              </span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone={kind.tone}>{kind.label}</Badge>
              <StatusBadge defs={OPERATION_STATUS} value={op.status} />
              {late && <Badge tone="vermelho">Atrasada</Badge>}
            </div>
            <p className="mt-1 truncate text-sm font-bold text-tinta-900">{op.customer ?? "Sem cliente"}</p>
            {op.items && <p className="truncate text-xs text-stone-600">{op.items}</p>}
            {endereco && <p className="truncate text-xs text-stone-500">{endereco}</p>}
            <p className="mt-0.5 text-xs text-stone-400">
              {op.reservation_number}
              {op.assignee ? ` · ${op.assignee}` : ""}
              {op.phone ? ` · ${phoneBR(op.phone)}` : ""}
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
          href={`/operacao/${op.id}`}
          className="flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1.5 text-xs font-semibold text-marca-600 hover:bg-white"
        >
          <Icon name="ok" className="h-4 w-4" /> Detalhes
        </Link>
      </div>
    </div>
  );
}
