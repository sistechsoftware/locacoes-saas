import Link from "next/link";
import AvailabilityFilter from "@/components/AvailabilityFilter";
import { availabilityQuery, type AvailabilityParams } from "@/lib/availability-time";
import { stockOptions } from "@/lib/availability-settings";
import { checkConflicts, holdWindow } from "@/lib/stock";
import ConflictList from "@/components/ConflictList";
import { dateTimeBR } from "@/lib/format";
import { notFound } from "next/navigation";
import { one } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { quoteItems } from "@/lib/reservations";
import { messageForQuote } from "@/lib/whatsapp";
import { logsFor } from "@/lib/audit";
import { QUOTE_STATUS } from "@/lib/domain";
import { dateBR, money, utcParaLocal } from "@/lib/format";
import { Alerta, Card, Empty, LinkButton, PageHeader, Row, Section, StatusBadge } from "@/components/ui";
import { Icon } from "@/components/Icons";
import { SubmitButton } from "@/components/SubmitButton";
import { convertQuote, deleteQuote, setQuoteStatus } from "../actions";

export const dynamic = "force-dynamic";

export default async function OrcamentoPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<AvailabilityParams & { erro?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  const { erro } = sp;
  const q = await one<any>(
    `SELECT qt.*, c.name AS customer_name, c.phone AS customer_phone, c.whatsapp AS customer_whatsapp
       FROM quotes qt JOIN customers c ON c.id = qt.customer_id WHERE qt.id = ?`,
    [Number(id)],
  );
  if (!q) notFound();

  const items = await quoteItems(q.id);
  const w = holdWindow(q);
  const query = availabilityQuery({ ...sp, inicio: w.from, fim: w.to, preparo: sp.preparo ?? (sp.consulta === "1" ? "0" : String(q.stock_consider_preparation)) });
  const options = await stockOptions(query);
  /* itens -> conflito/mensagem/historico em paralelo (leituras independentes:
     antes cada uma esperava a anterior, somando latencias do D1) */
  const [conflicts, msg, historico] = await Promise.all([
    q.status === "convertido" ? Promise.resolve([]) : checkConflicts(items, w.from, w.to, null, options),
    messageForQuote(q, items.map((i) => `- ${i.qty}x ${i.product_name}: ${money(i.subtotal_cents)}`).join("\n")),
    logsFor("orcamento", q.id),
  ]);
  const resumo = items.map((i) => `${i.qty}x ${i.product_name}`).join(", ");

  return (
    <div className="space-y-4">
      <PageHeader
        title={q.number}
        subtitle={`${q.customer_name}${q.event_date ? ` - evento em ${dateBR(q.event_date)}` : ""}`}
        action={
          q.status !== "convertido" ? (
            <>
              <LinkButton href={`/orcamentos/${q.id}/imprimir`} variant="primario">
                Gerar PDF
              </LinkButton>
              <LinkButton href={`/orcamentos/${q.id}/editar`}>Editar</LinkButton>
            </>
          ) : (
            <>
              <LinkButton href={`/orcamentos/${q.id}/imprimir`} variant="primario">
                Gerar PDF
              </LinkButton>
              <LinkButton href={`/reservas/${q.reservation_id}`}>Ver reserva</LinkButton>
            </>
          )
        }
      />

      {erro && <Alerta tone="vermelho" title="Não foi possível converter">{erro}</Alerta>}
      {q.status !== "convertido" && <>
        <AvailabilityFilter query={query} minutes={options.preparationMinutes} fixed />
        {conflicts.length > 0 && <Alerta tone="ambar" title="Conflitos para converter em reserva"><ConflictList conflicts={conflicts} /></Alerta>}
      </>}

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge defs={QUOTE_STATUS} value={q.status} />
          {q.valid_until && <span className="text-xs text-stone-500">Válido até {dateBR(q.valid_until)}</span>}
        </div>

        {q.status !== "convertido" && (
          <>
            <form action={setQuoteStatus} className="mt-3 flex flex-wrap items-center gap-2">
              <input type="hidden" name="id" value={q.id} />
              <select name="status" defaultValue={q.status} className="campo w-auto">
                {QUOTE_STATUS.filter((s) => s.value !== "convertido").map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <SubmitButton variant="secundario">Alterar status</SubmitButton>
            </form>

            <form action={convertQuote} className="mt-3 space-y-2">
              <input type="hidden" name="consider_preparation" value={query.considerPreparation ? "1" : "0"} />
              <input type="hidden" name="id" value={q.id} />
              {user.role === "admin" && (
                <label className="flex items-center gap-2 text-xs font-semibold text-stone-600">
                  <input type="checkbox" name="override" value="1" className="h-4 w-4" />
                  Converter mesmo com estoque insuficiente (administrador)
                </label>
              )}
              <SubmitButton variant="sucesso" className="w-full sm:w-auto">
                Converter Orçamento em Reserva
              </SubmitButton>
            </form>
          </>
        )}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Dados">
          <Row
            label="Cliente"
            value={
              <Link href={`/clientes/${q.customer_id}`} className="text-marca-600">
                {q.customer_name}
              </Link>
            }
          />
          <Row label="Data do evento" value={q.event_date ? dateBR(q.event_date) : "-"} />
          <Row label="Horário" value={q.event_time || "-"} />
          <Row label="Endereço" value={[q.address, q.district, q.city].filter(Boolean).join(", ") || "-"} />
          <Row label="Entrega prevista" value={q.delivery_at ? dateTimeBR(q.delivery_at) : "-"} />
          <Row label="Retirada prevista" value={q.pickup_at ? dateTimeBR(q.pickup_at) : "-"} />
          {q.notes && <Row label="Observações" value={q.notes} />}
        </Section>

        <Section title={`Itens (${items.length})`}>
          {items.length === 0 ? (
            <Empty>Nenhum item.</Empty>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {items.map((i) => (
                <li key={i.id} className="flex items-center justify-between py-2 text-sm">
                  <span>
                    {i.qty} x {i.product_name}
                    <span className="block text-xs text-stone-500">{money(i.unit_price_cents)} cada</span>
                  </span>
                  <span className="font-bold">{money(i.subtotal_cents)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 space-y-1 rounded-xl bg-nuvem-100 p-3 text-sm">
            <Row label="Produtos" value={money(q.items_cents)} />
            <Row label="Frete" value={money(q.freight_cents)} />
            <Row label="Montagem" value={money(q.assembly_cents)} />
            <Row label="Desmontagem" value={money(q.disassembly_cents)} />
            <Row label="Outros" value={money(q.other_cents)} />
            <Row label="Desconto" value={"- " + money(q.discount_cents)} />
            <div className="flex items-center justify-between pt-1 text-base font-bold">
              <span>Total</span>
              <span>{money(q.total_cents)}</span>
            </div>
          </div>
        </Section>
      </div>

      <Section title="Enviar ao cliente">
        {msg.href ? (
          <a
            href={msg.href}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm font-semibold text-emerald-800"
          >
            <Icon name="whatsapp" className="h-5 w-5 shrink-0" />
            <span className="min-w-0">
              <span className="block">Enviar orçamento pelo WhatsApp</span>
              <span className="block truncate text-xs font-normal opacity-80">{resumo}</span>
            </span>
          </a>
        ) : (
          <Empty>Cliente sem telefone cadastrado.</Empty>
        )}
        <pre className="mt-3 whitespace-pre-wrap rounded-xl bg-nuvem-100 p-3 text-xs text-tinta-800">{msg.text}</pre>
      </Section>

      {historico.length > 0 && (
        <Section title="Histórico">
          <ul className="space-y-1.5 text-sm">
            {historico.map((h: any) => (
              <li key={h.id} className="flex gap-2 text-stone-600">
                <span className="shrink-0 text-xs text-stone-400">{utcParaLocal(h.created_at)}</span>
                <span>{h.summary}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {user.role === "admin" && q.status !== "convertido" && (
        <Card className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-tinta-900">Área do administrador</p>
          <form action={deleteQuote}>
            <input type="hidden" name="id" value={q.id} />
            <SubmitButton variant="perigo" confirm={`Excluir o orçamento ${q.number}?`}>
              Excluir Orçamento
            </SubmitButton>
          </form>
        </Card>
      )}
    </div>
  );
}
