import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { agendaEvents } from "@/lib/queries";
import { addDays, dateBR, endOfMonth, startOfMonth, startOfWeek, today, weekdayBR } from "@/lib/format";
import { Card, Empty, LinkButton, PageHeader } from "@/components/ui";
import { Tabs } from "@/components/List";

export const dynamic = "force-dynamic";

const CORES: Record<string, { dot: string; chip: string; label: string; icon: string }> = {
  entrega: { dot: "bg-emerald-500", chip: "bg-emerald-100 text-emerald-800", label: "Entrega", icon: "🟢" },
  retirada: { dot: "bg-sky-500", chip: "bg-sky-100 text-sky-800", label: "Retirada", icon: "🔵" },
  montagem: { dot: "bg-amber-500", chip: "bg-amber-100 text-amber-800", label: "Montagem", icon: "🟠" },
  desmontagem: { dot: "bg-violet-500", chip: "bg-violet-100 text-violet-800", label: "Desmontagem", icon: "🟣" },
  frete: { dot: "bg-fuchsia-500", chip: "bg-fuchsia-100 text-fuchsia-800", label: "Frete", icon: "🟣" },
  evento: { dot: "bg-marca-600", chip: "bg-marca-100 text-marca-700", label: "Evento", icon: "🟤" },
};

export default async function AgendaPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; data?: string; tipo?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  const view = sp.view ?? "dia";
  const data = sp.data || today();
  const tipo = sp.tipo ?? "";

  let from = data;
  let to = data;
  if (view === "semana") {
    from = startOfWeek(data);
    to = addDays(from, 6);
  } else if (view === "mes") {
    from = startOfMonth(data);
    to = endOfMonth(data);
  }

  const eventos = (await agendaEvents(from, to)).filter((e) => !tipo || e.kind === tipo);

  const step = view === "mes" ? "mes" : view === "semana" ? 7 : 1;
  const nav = (dir: number) => {
    const base =
      step === "mes"
        ? shiftMonth(data, dir)
        : addDays(data, (step as number) * dir);
    return `/agenda?view=${view}&data=${base}${tipo ? `&tipo=${tipo}` : ""}`;
  };

  const porDia = new Map<string, typeof eventos>();
  for (const e of eventos) porDia.set(e.date, [...(porDia.get(e.date) ?? []), e]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Agenda"
        subtitle={view === "dia" ? dateBR(data) : `${dateBR(from)} até ${dateBR(to)}`}
        action={<LinkButton href="/operacao/nova" variant="primario">+ Novo Evento</LinkButton>}
      />

      <Tabs
        items={[
          { value: "dia", label: "Dia" },
          { value: "semana", label: "Semana" },
          { value: "mes", label: "Mês" },
        ]}
        current={view}
        base={`/agenda?data=${data}${tipo ? `&tipo=${tipo}` : ""}`}
        param="view"
      />

      <Card padded={false}>
        {/* Encaixa em 320px: os tres blocos se encolhem juntos em vez de
            estourar a largura e apertar o campo de data */}
        <div className="flex items-center justify-between gap-1.5 p-2 sm:gap-2">
          <Link
            href={nav(-1)}
            className="shrink-0 whitespace-nowrap rounded-xl border border-nuvem-300 bg-white px-3 py-2 text-sm font-semibold sm:px-4"
          >
            Anterior
          </Link>
          <form className="flex min-w-0 flex-1 items-center justify-center gap-1.5">
            <input type="hidden" name="view" value={view} />
            {tipo && <input type="hidden" name="tipo" value={tipo} />}
            <input type="date" name="data" defaultValue={data} className="campo data-hora min-w-0 flex-1 py-2" />
            <button
              className="shrink-0 rounded-xl bg-marca-600 px-3 py-2 text-sm font-semibold text-white"
              aria-label="Ir para a data"
            >
              Ir
            </button>
          </form>
          <Link
            href={nav(1)}
            className="shrink-0 whitespace-nowrap rounded-xl border border-nuvem-300 bg-white px-3 py-2 text-sm font-semibold sm:px-4"
          >
            Próximo
          </Link>
        </div>
      </Card>

      <div className="scroll-x -mx-3 abas-barra px-3 sm:mx-0 sm:px-0">
        <Link
          href={`/agenda?view=${view}&data=${data}`}
          className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold ${
            !tipo ? "border-marca-600 bg-marca-600 text-white" : "border-nuvem-300 bg-white"
          }`}
        >
          Tudo
        </Link>
        {Object.entries(CORES).map(([k, c]) => (
          <Link
            key={k}
            href={`/agenda?view=${view}&data=${data}&tipo=${k}`}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${
              tipo === k ? "border-marca-600 bg-marca-600 text-white" : "border-nuvem-300 bg-white"
            }`}
          >
            <span className={`h-2 w-2 rounded-full ${c.dot}`} /> {c.label}
          </Link>
        ))}
      </div>

      {view === "mes" && <MesGrid from={from} to={to} eventos={eventos} data={data} />}

      {eventos.length === 0 ? (
        <Empty>Nenhum compromisso neste período.</Empty>
      ) : (
        <div className="space-y-4">
          {[...porDia.entries()].map(([dia, lista]) => (
            <section key={dia}>
              <h2 className="mb-2 flex items-center gap-2 text-sm font-bold text-tinta-900">
                <span className="rounded-lg bg-marca-600 px-2 py-1 text-xs uppercase text-white">
                  {weekdayBR(dia)} {dia.slice(8, 10)}/{dia.slice(5, 7)}
                </span>
                <span className="text-xs font-normal text-stone-500">{lista.length} compromisso(s)</span>
              </h2>
              <div className="space-y-1.5">
                {lista.map((e) => {
                  const c = CORES[e.kind] ?? CORES.evento;
                  return (
                    <Link key={e.id} href={e.href} className="cartao flex items-center gap-3 p-3">
                      <span className="w-12 shrink-0 text-sm font-bold text-tinta-900">{e.time || "--:--"}</span>
                      <span className={`h-8 w-1 shrink-0 rounded-full ${c.dot}`} />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className={`rounded-full px-2 py-0.5 text-[0.65rem] font-bold ${c.chip}`}>
                            {c.label}
                          </span>
                          <span className="truncate text-sm font-bold text-tinta-900">{e.title}</span>
                        </span>
                        <span className="block truncate text-xs text-stone-500">{e.subtitle}</span>
                      </span>
                    </Link>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function MesGrid({ from, to, eventos, data }: { from: string; to: string; eventos: any[]; data: string }) {
  const first = startOfWeek(from);
  const days: string[] = [];
  let cursor = first;
  while (cursor <= to || days.length % 7 !== 0) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
    if (days.length > 41) break;
  }
  const count = new Map<string, number>();
  for (const e of eventos) count.set(e.date, (count.get(e.date) ?? 0) + 1);

  return (
    <Card padded={false}>
      <div className="grid grid-cols-7 border-b border-nuvem-200 text-center text-[0.65rem] font-bold uppercase text-stone-400">
        {["seg", "ter", "qua", "qui", "sex", "sáb", "dom"].map((d) => (
          <span key={d} className="py-2">
            {d}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7">
        {days.map((d) => {
          const n = count.get(d) ?? 0;
          const outOfMonth = d.slice(0, 7) !== from.slice(0, 7);
          return (
            <Link
              key={d}
              href={`/agenda?view=dia&data=${d}`}
              className={`min-h-14 border-b border-r border-nuvem-200 p-1.5 text-center ${
                outOfMonth ? "bg-nuvem-50 text-stone-300" : "text-tinta-900"
              } ${d === data ? "ring-2 ring-inset ring-marca-400" : ""}`}
            >
              <span className="block text-xs font-semibold">{Number(d.slice(8, 10))}</span>
              {n > 0 && (
                <span className="mt-0.5 inline-block rounded-full bg-marca-600 px-1.5 text-[0.6rem] font-bold text-white">
                  {n}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </Card>
  );
}

function shiftMonth(dateISO: string, dir: number) {
  const [y, m] = dateISO.split("-").map(Number);
  const d = new Date(y, m - 1 + dir, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
