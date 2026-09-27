import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { globalSearch } from "@/lib/queries";
import { CONTRACT_STATUS, FREIGHT_STATUS, QUOTE_STATUS, RESERVATION_STATUS, UNIT_STATUS } from "@/lib/domain";
import { dateBR, money, phoneBR } from "@/lib/format";
import { Empty, PageHeader, Section, StatusBadge } from "@/components/ui";
import { ListRow, SearchForm } from "@/components/List";

export const dynamic = "force-dynamic";

export default async function BuscaPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireUser();
  const { q = "" } = await searchParams;
  const termo = q.trim();
  if (!termo) redirect("/dashboard");

  const r = await globalSearch(termo);

  // atalho: numero exato de reserva abre direto
  const exata = r.reservations.find((x: any) => x.number.toLowerCase() === termo.toLowerCase());
  if (exata) redirect(`/reservas/${exata.id}`);

  const totalResultados =
    r.customers.length +
    r.reservations.length +
    r.quotes.length +
    r.freights.length +
    r.products.length +
    r.units.length +
    r.contracts.length;

  return (
    <div className="space-y-4">
      <PageHeader title={`Busca: "${termo}"`} subtitle={`${totalResultados} resultado(s)`} />
      <SearchForm action="/busca" placeholder="Cliente, telefone, LIMA-001, endereço…" defaultValue={termo} />

      {totalResultados === 0 && <Empty>Nada encontrado para este termo.</Empty>}

      {r.customers.length > 0 && (
        <Section title={`Clientes (${r.customers.length})`}>
          <div className="space-y-2">
            {r.customers.map((c: any) => (
              <ListRow
                key={c.id}
                href={`/clientes/${c.id}`}
                title={c.name}
                subtitle={[phoneBR(c.phone), c.district].filter(Boolean).join(" · ")}
                meta={`${c.locacoes} locação(ões) · total ${money(c.total_cents)}`}
                right={c.saldo_cents > 0 ? <span className="text-xs font-bold text-red-600">{money(c.saldo_cents)}</span> : null}
              />
            ))}
          </div>
        </Section>
      )}

      {r.reservations.length > 0 && (
        <Section title={`Reservas (${r.reservations.length})`}>
          <div className="space-y-2">
            {r.reservations.map((x: any) => (
              <ListRow
                key={x.id}
                href={`/reservas/${x.id}`}
                badges={<StatusBadge defs={RESERVATION_STATUS} value={x.status} />}
                title={`${x.number} - ${x.customer_name}`}
                subtitle={dateBR(x.event_date)}
                right={<span className="text-sm font-bold">{money(x.total_cents)}</span>}
              />
            ))}
          </div>
        </Section>
      )}

      {r.quotes.length > 0 && (
        <Section title={`Orçamentos (${r.quotes.length})`}>
          <div className="space-y-2">
            {r.quotes.map((x: any) => (
              <ListRow
                key={x.id}
                href={`/orcamentos/${x.id}`}
                badges={<StatusBadge defs={QUOTE_STATUS} value={x.status} />}
                title={`${x.number} - ${x.customer_name}`}
                subtitle={x.event_date ? dateBR(x.event_date) : "sem data"}
                right={<span className="text-sm font-bold">{money(x.total_cents)}</span>}
              />
            ))}
          </div>
        </Section>
      )}

      {r.freights.length > 0 && (
        <Section title={`Fretes (${r.freights.length})`}>
          <div className="space-y-2">
            {r.freights.map((x: any) => (
              <ListRow
                key={x.id}
                href={`/fretes/${x.id}`}
                badges={<StatusBadge defs={FREIGHT_STATUS} value={x.status} />}
                title={`${x.number} - ${x.customer_name ?? x.contact_name ?? ""}`}
                subtitle={`${dateBR(x.date)} · ${x.origin ?? ""} até ${x.destination ?? ""}`}
                right={<span className="text-sm font-bold">{money(x.amount_cents)}</span>}
              />
            ))}
          </div>
        </Section>
      )}

      {r.contracts.length > 0 && (
        <Section title={`Contratos (${r.contracts.length})`}>
          <div className="space-y-2">
            {r.contracts.map((x: any) => (
              <ListRow
                key={x.id}
                href={`/contratos/${x.id}`}
                badges={<StatusBadge defs={CONTRACT_STATUS} value={x.status} />}
                title={`${x.number} - ${x.customer_name}`}
                subtitle={x.reservation_number}
              />
            ))}
          </div>
        </Section>
      )}

      {r.products.length > 0 && (
        <Section title={`Produtos (${r.products.length})`}>
          <div className="space-y-2">
            {r.products.map((x: any) => (
              <ListRow
                key={x.id}
                href={`/estoque/${x.id}`}
                title={x.name}
                subtitle={`${x.code} - ${x.category ?? "sem categoria"}`}
                right={<span className="text-sm font-bold">{x.total_qty} un.</span>}
              />
            ))}
          </div>
        </Section>
      )}

      {r.units.length > 0 && (
        <Section title={`Equipamentos individuais (${r.units.length})`}>
          <div className="space-y-2">
            {r.units.map((x: any) => (
              <ListRow
                key={x.id}
                href={`/estoque/${x.product_id}`}
                badges={<StatusBadge defs={UNIT_STATUS} value={x.status} />}
                title={x.code}
                subtitle={x.product_name}
              />
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}
