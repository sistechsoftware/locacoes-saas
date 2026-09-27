import Link from "next/link";
import { dateTimeBR, timeBR } from "@/lib/format";
import { PHASE_DEFS, PHASE_LABEL, type TimelineRow } from "@/lib/timeline";

/**
 * Grafico de ocupacao no estilo hotelaria, renderizado no servidor.
 *
 * Cada linha e um equipamento (ou kit). O fundo e a faixa de capacidade
 * (unidades livres por trecho) e por cima vem as pistas com os blocos de cada
 * reserva. Sem JavaScript: navegacao por querystring, tooltip nativo do
 * navegador (title).
 */

const ALTURA_LANE = 16; // px, alinhado com h-4
const GAP_LANE = 2; // px
const MIN_FRACTION = 0.004; // largura minima de um bloco (0.4%) para ficar visivel

export default function TimelineChart({
  from,
  to,
  rows,
  queryString,
  limitePistas = 4,
}: {
  from: string;
  to: string;
  rows: TimelineRow[];
  queryString: string;
  limitePistas?: number;
}) {
  const inicio = new Date(`${from}:00Z`);
  const fimT = new Date(`${to}:00Z`);
  const totalMin = Math.max(1, (fimT.getTime() - inicio.getTime()) / 60000);

  // marcadores de hora: inteiro em janelas de ate ~2 dias, senao a cada 6h;
  // em visoes de varios dias, marca a virada do dia
  const multiDia = totalMin > 60 * 36;
  const passos: string[] = [];
  if (multiDia) {
    const d = new Date(inicio);
    d.setUTCHours(0, 0, 0, 0);
    while (d.getTime() <= fimT.getTime()) {
      passos.push(d.toISOString().slice(0, 16));
      d.setUTCDate(d.getUTCDate() + 1);
    }
  } else {
    const stepMin = totalMin <= 60 * 14 ? 60 : totalMin <= 60 * 26 ? 120 : 180;
    const d = new Date(inicio);
    d.setUTCMinutes(0, 0, 0);
    while (d.getTime() <= fimT.getTime()) {
      passos.push(d.toISOString().slice(0, 16));
      d.setUTCMinutes(d.getUTCMinutes() + stepMin);
    }
  }

  const pct = (t: string) => {
    const ms = (new Date(`${t}:00Z`).getTime() - inicio.getTime()) / 60000;
    return Math.min(100, Math.max(0, (ms / totalMin) * 100));
  };

  const agora = nowStamp();
  const mostraAgora = agora >= from && agora <= to;

  return (
    <div className="cartao overflow-hidden">
      <div className="overflow-x-auto">
        <div className="min-w-[640px]">
          {/* cabecalho de horas */}
          <div className="flex border-b border-nuvem-200 bg-nuvem-50">
            <div className="w-44 shrink-0 px-3 py-2 text-[0.65rem] font-bold uppercase tracking-wide text-stone-400">
              Equipamento
            </div>
            <div className="relative min-w-0 flex-1">
              <div className="flex">
                {passos.map((p) => (
                  <span
                    key={p}
                    className="shrink-0 border-l border-nuvem-200 px-1 py-1.5 text-[0.6rem] font-semibold text-stone-400"
                    style={{ width: `${(1 / passos.length) * 100}%` }}
                  >
                    {multiDia ? `${p.slice(8, 10)}/${p.slice(5, 7)}` : timeBR(p)}
                  </span>
                ))}
              </div>
              {mostraAgora && (
                <span
                  className="absolute top-0 bottom-0 w-px bg-rose-500/70"
                  style={{ left: `${pct(agora)}%` }}
                  title="Agora"
                />
              )}
            </div>
          </div>

          {/* linhas */}
          {rows.map((row) => (
            <Row key={row.product_id} row={row} pct={pct} totalMin={totalMin} queryString={queryString} limitePistas={limitePistas} />
          ))}

          {rows.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-stone-500">Nenhum equipamento ativo cadastrado.</p>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-nuvem-200 bg-nuvem-50 px-4 py-2.5 text-xs text-stone-600">
        <span className="font-bold uppercase tracking-wide text-stone-400">Legenda:</span>
        {PHASE_DEFS.map((p) => (
          <span key={p.phase} className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-4 rounded-sm ${p.tone}`} /> {p.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Row({
  row,
  pct,
  totalMin,
  queryString,
  limitePistas,
}: {
  row: TimelineRow;
  pct: (t: string) => number;
  totalMin: number;
  queryString: string;
  limitePistas: number;
}) {
  const pistaAlta = Math.min(row.lanes.length, limitePistas);
  const alturaConteudo = Math.max(1, pistaAlta) * ALTURA_LANE + Math.max(0, pistaAlta - 1) * GAP_LANE;
  const ocupacao = row.effective > 0 ? Math.min(100, Math.round((row.peak_used / row.effective) * 100)) : null;

  return (
    <div className="flex border-b border-nuvem-100 last:border-0">
      <div className="w-44 shrink-0 border-r border-nuvem-200 px-3 py-2">
        <Link href={`/estoque/${row.product_id}?${queryString}`} className="block truncate text-sm font-bold text-tinta-900 hover:text-marca-600">
          {row.name}
        </Link>
        <p className="truncate text-[0.65rem] uppercase tracking-wide text-stone-400">
          {row.kind === "kit" ? "kit" : row.category ?? "item"}
        </p>
      </div>

      <div className="relative min-w-0 flex-1">
        {/* faixa de capacidade: fundo com os degraus de disponibilidade */}
        <div className="relative flex" style={{ height: alturaConteudo }}>
          {row.faixa.map((f) => {
            const left = pct(f.from);
            const width = Math.max(MIN_FRACTION * 100, pct(f.to) - left);
            const livre = Math.max(0, f.available);
            const cheio = livre <= 0;
            return (
              <div
                key={f.from}
                className={`absolute top-0 bottom-0 ${cheio ? "bg-red-50" : "bg-emerald-50"}`}
                style={{ left: `${left}%`, width: `${width}%` }}
                title={`${f.from === f.to ? dateTimeBR(f.from) : `${dateTimeBR(f.from)} → ${dateTimeBR(f.to)}`}: ${livre} livre(s)`}
              />
            );
          })}

          {/* marcador de agora */}
          <Agora pct={pct} />

          {/* pistas */}
          <div className="absolute inset-0 flex flex-col justify-center gap-[2px] px-0.5">
            {row.lanes.map((lane) => (
              <div key={lane.index} className="relative" style={{ height: ALTURA_LANE }}>
                {lane.blocks.map((b, i) => {
                  const left = pct(b.from);
                  const width = Math.max(MIN_FRACTION * 100, pct(b.to) - left);
                  const cor = PHASE_DEFS.find((p) => p.phase === b.phase)?.tone ?? "bg-amber-400";
                  return (
                    <Link
                      key={`${b.reservationId}-${i}-${b.from}`}
                      href={`/reservas/${b.reservationId}`}
                      className={`absolute top-0 flex h-full items-center overflow-hidden rounded-md px-1 text-[0.6rem] font-bold text-white shadow-sm ${cor}`}
                      style={{ left: `${left}%`, width: `${width}%` }}
                      title={`${b.title} · ${dateTimeBR(b.from)} → ${dateTimeBR(b.to)} · ${PHASE_LABEL[b.phase]}`}
                    >
                      <span className="truncate">{b.title}</span>
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* resumo a direita da faixa */}
        <p className="absolute right-1 top-1 hidden text-[0.6rem] font-semibold text-stone-400 sm:block">
          {row.lanesTotal > 0
            ? `${row.peak_used}/${row.effective > 0 ? row.effective : "—"}${ocupacao !== null ? ` · ${ocupacao}%` : ""}${row.lanesTotal > limitePistas ? ` · +${row.lanesTotal - limitePistas} pista(s)` : ""}`
            : row.kind === "kit"
              ? `${row.effective} kit(s) livres`
              : `${row.effective} livre(s)`}
        </p>
      </div>
    </div>
  );
}

function Agora({ pct }: { pct: (t: string) => number }) {
  // o marcador e renderizado pelo servidor na carga da pagina
  const t = nowStamp();
  return <span className="absolute top-0 bottom-0 w-px bg-rose-500/70" style={{ left: `${pct(t)}%` }} title="Agora" />;
}

function nowStamp(): string {
  // relogio do fuso do negocio, sem depender do fuso do servidor
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? "00";
  const hora = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hora}:${get("minute")}`;
}
