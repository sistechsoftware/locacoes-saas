import Link from "next/link";
import AvailabilityFilter from "@/components/AvailabilityFilter";
import { availabilityQuery, type AvailabilityParams } from "@/lib/availability-time";
import { stockOptions } from "@/lib/availability-settings";
import { scanConflicts } from "@/lib/stock";
import { requireUser } from "@/lib/auth";
import { listNotifications, rebuildNotifications } from "@/lib/notifications";
import { Empty, PageHeader, Stat } from "@/components/ui";
import { Tabs } from "@/components/List";
import { SubmitButton } from "@/components/SubmitButton";
import { markAllRead, markRead } from "../actions";
import { utcParaLocal } from "@/lib/format";

export const dynamic = "force-dynamic";

const TIPOS = [
  { value: "todos", label: "Todos" },
  { value: "entrega", label: "Entregas" },
  { value: "retirada", label: "Retiradas" },
  { value: "pagamento", label: "Pagamentos" },
  { value: "conflito", label: "Conflitos" },
  { value: "contrato", label: "Contratos" },
  { value: "caucao", label: "Caução" },
  { value: "estoque", label: "Estoque" },
];

export default async function NotificacoesPage({
  searchParams,
}: {
  searchParams: Promise<AvailabilityParams & { tipo?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  const { tipo = "todos" } = sp;
  const query = availabilityQuery(sp);
  const options = await stockOptions(query);
  const conflicts = await scanConflicts(query.from, options, query.to);
  await rebuildNotifications({ force: true });
  const todas = await listNotifications();
  const lista = tipo === "todos" ? todas : todas.filter((n: any) => n.type === tipo);

  const criticos = todas.filter((n: any) => n.severity === "critico").length;
  const avisos = todas.filter((n: any) => n.severity === "aviso").length;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Notificações"
        subtitle={`${todas.length} alerta(s) ativo(s)`}
        action={
          <form action={markAllRead}>
            <SubmitButton variant="secundario">Marcar tudo como lido</SubmitButton>
          </form>
        }
      />

      <div className="grid grid-cols-3 gap-2.5">
        <Stat label="Críticos" value={criticos} tone={criticos ? "vermelho" : undefined} />
        <Stat label="Avisos" value={avisos} />
        <Stat label="Não lidos" value={todas.filter((n: any) => !n.read_at).length} />
      </div>

      <Link href="/notificacoes" className="text-marca-600 underline">Minha central de notificações</Link>
      <AvailabilityFilter query={query} minutes={options.preparationMinutes} hidden={{ tipo }} />
      <section className="cartao p-3 space-y-2"><h2 className="font-semibold">Conflitos no horário ou intervalo consultado</h2>
        {!conflicts.length && <p className="text-sm">Nenhum conflito de estoque nesta consulta.</p>}
        {conflicts.map((c) => <p key={c.reservation_id} className="text-sm"><Link href={`/reservas/${c.reservation_id}?preparo=${query.considerPreparation ? 1 : 0}`} className="text-marca-600 underline">{c.number}</Link>: {c.faltas.map(f => `${f.product}: faltam ${f.missing}`).join("; ")}</p>)}
      </section>
      <p className="text-xs text-stone-500">Os alertas automáticos abaixo verificam os compromissos futuros com a preparação configurada sempre ativa. O filtro acima é uma simulação e não altera alertas compartilhados.</p>
      <Tabs items={TIPOS} current={tipo} base={`/notificacoes/alertas?${query.queryString}`} param="tipo" />

      {lista.length === 0 ? (
        <Empty>Nenhum alerta neste filtro. Operacao em dia.</Empty>
      ) : (
        <div className="space-y-2">
          {lista.map((n: any) => (
            <div
              key={n.id}
              className={`cartao p-3 ${
                n.severity === "critico"
                  ? "border-red-300 bg-red-50"
                  : n.severity === "aviso"
                    ? "border-amber-300 bg-amber-50"
                    : ""
              } ${n.read_at ? "opacity-60" : ""}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-tinta-900">{n.title}</p>
                  {n.body && <p className="text-xs text-stone-600">{n.body}</p>}
                  <p className="mt-0.5 text-[0.65rem] uppercase tracking-wide text-stone-400">
                    {n.type} · {utcParaLocal(n.created_at)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  {n.link && (
                    <Link href={n.link} className="rounded-lg bg-marca-600 px-3 py-1.5 text-xs font-semibold text-white">
                      Abrir
                    </Link>
                  )}
                  {!n.read_at && (
                    <form action={markRead}>
                      <input type="hidden" name="id" value={n.id} />
                      <SubmitButton variant="fantasma" className="px-2 py-1 text-xs">
                        Lido
                      </SubmitButton>
                    </form>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
