import { requireUser } from "@/lib/auth";
import { availabilityQuery, type AvailabilityParams } from "@/lib/availability-time";
import { stockOptions } from "@/lib/availability-settings";
import { equipmentTimeline } from "@/lib/timeline";
import { addDays, dateTimeBR, today } from "@/lib/format";
import { Stat } from "@/components/ui";
import AvailabilityFilter from "@/components/AvailabilityFilter";
import TimelineChart from "@/components/TimelineChart";
import { dateBR } from "@/lib/format";

export const dynamic = "force-dynamic";

/**
 * Timeline de disponibilidade (visao de hotelaria).
 *
 * Leitura visual de apoio a operacao: quando cada equipamento esta livre,
 * reservado, em transporte, em uso, aguardando devolucao ou em preparo. Nao
 * calcula estoque novo — reusa exatamente o motor da tela de disponibilidade
 * (mesma janela, mesmo preparo, mesmas ocupacoes).
 */
export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<AvailabilityParams & { modo?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  const query = availabilityQuery(sp);
  const options = await stockOptions(query);
  const modo = sp.modo === "todos" ? "todos" : "ocupados";

  const rows = await equipmentTimeline(query.from, query.to, options, {
    apenasOcupados: modo === "ocupados",
  });

  const ocupados = rows.filter((r) => r.lanesTotal > 0);
  const totalPistas = ocupados.reduce((s, r) => s + r.lanesTotal, 0);
  const simultaneo = ocupados.reduce((s, r) => Math.max(s, r.peak_used), 0);
  const livreAgora = rows.reduce((s, r) => {
    const trecho = r.faixa.find((f) => query.from >= f.from && query.from < f.to);
    return s + Math.max(0, trecho?.available ?? r.faixa[0]?.available ?? 0);
  }, 0);

  const qs = query.queryString;
  const linkModo = (m: string) => `/disponibilidade/timeline?${qs}&modo=${m}`;
  const linkPeriodo = (f: string, t: string) => `/disponibilidade/timeline?${qs}&inicio=${f}&fim=${t}&modo=${modo}`;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-tinta-900 sm:text-2xl">Timeline de disponibilidade</h1>
        <p className="mt-0.5 text-sm text-stone-500">
          Ocupação no estilo pousada: quando cada equipamento sai, volta e libera
        </p>
      </div>

      <div className="scroll-x -mx-3 abas-barra px-3 sm:mx-0 sm:px-0">
        <a
          href={linkModo("ocupados")}
          className={`shrink-0 rounded-full border px-3 py-1.5 text-sm font-semibold ${
            modo === "ocupados" ? "border-marca-600 bg-marca-600 text-white" : "border-nuvem-300 bg-white"
          }`}
        >
          Com ocupação
        </a>
        <a
          href={linkModo("todos")}
          className={`shrink-0 rounded-full border px-3 py-1.5 text-sm font-semibold ${
            modo === "todos" ? "border-marca-600 bg-marca-600 text-white" : "border-nuvem-300 bg-white"
          }`}
        >
          Todos os equipamentos
        </a>
      </div>

      <AvailabilityFilter query={query} minutes={options.preparationMinutes} />

      <div className="scroll-x -mx-3 abas-barra px-3 sm:mx-0 sm:px-0">
        <a href={linkPeriodo(today() + "T00:00", today() + "T23:59")} className="shrink-0 rounded-full border border-nuvem-300 bg-white px-3 py-1.5 text-sm font-semibold">
          Hoje
        </a>
        <a href={linkPeriodo(addDays(today(), 1) + "T00:00", addDays(today(), 1) + "T23:59")} className="shrink-0 rounded-full border border-nuvem-300 bg-white px-3 py-1.5 text-sm font-semibold">
          Amanhã
        </a>
        <a href={linkPeriodo(today() + "T00:00", addDays(today(), 6) + "T23:59")} className="shrink-0 rounded-full border border-nuvem-300 bg-white px-3 py-1.5 text-sm font-semibold">
          7 dias
        </a>
        <a href={linkPeriodo(today() + "T00:00", addDays(today(), 29) + "T23:59")} className="shrink-0 rounded-full border border-nuvem-300 bg-white px-3 py-1.5 text-sm font-semibold">
          30 dias
        </a>
      </div>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Janela" value={`${dateBR(query.from)} ${dateTimeBR(query.from).slice(-5)} → ${dateBR(query.to)} ${dateTimeBR(query.to).slice(-5)}`} />
        <Stat label="Equipamentos em uso na janela" value={ocupados.length} tone={ocupados.length > 0 ? "vermelho" : "verde"} />
        <Stat label="Maior uso simultâneo" value={simultaneo} />
        <Stat label="Unidades livres no início" value={livreAgora} tone="verde" />
      </div>

      <TimelineChart from={query.from} to={query.to} rows={rows} queryString={qs} />

      <p className="px-1 text-xs text-stone-500">
        Fuso de São Paulo{options.preparationMinutes > 0 ? ` · ${options.preparationMinutes} min de higienização/preparo considerados após cada devolução` : " · sem preparo adicional"}.
        A faixa verde clara mostra unidades livres; vermelho claro, esgotado. Clique em um bloco para abrir a reserva.
      </p>
    </div>
  );
}
