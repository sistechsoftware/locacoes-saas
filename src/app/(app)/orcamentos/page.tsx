import { all, scalar } from "@/lib/db";
import { QUOTE_STATUS } from "@/lib/domain";
import { dateBR, money } from "@/lib/format";
import { Empty, LinkButton, PageHeader, StatusBadge } from "@/components/ui";
import { ListRow, Pagination, SearchForm, Tabs } from "@/components/List";

export const dynamic = "force-dynamic";
const PER_PAGE = 20;

export default async function OrcamentosPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; aba?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const aba = sp.aba ?? "abertos";
  const page = Math.max(1, Number(sp.page ?? 1));

  const where: string[] = [];
  const params: any[] = [];
  if (q) {
    where.push("(qt.number LIKE ? OR c.name LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (aba === "abertos") where.push("qt.status IN ('rascunho','enviado','aguardando')");
  else if (aba === "aprovados") where.push("qt.status = 'aprovado'");
  else if (aba === "convertidos") where.push("qt.status = 'convertido'");
  else if (aba === "recusados") where.push("qt.status = 'recusado'");

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await scalar<number>(`SELECT COUNT(*) FROM quotes qt JOIN customers c ON c.id = qt.customer_id ${clause}`, params);
  const rows = await all<any>(
    `SELECT qt.*, c.name AS customer_name FROM quotes qt JOIN customers c ON c.id = qt.customer_id
     ${clause} ORDER BY qt.id DESC LIMIT ? OFFSET ?`,
    [...params, PER_PAGE, (page - 1) * PER_PAGE],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Orçamentos"
        subtitle={`${total} orçamento(s)`}
        action={<LinkButton href="/orcamentos/novo" variant="primario">+ Novo Orçamento</LinkButton>}
      />

      <SearchForm action="/orcamentos" placeholder="ORC-001, cliente..." defaultValue={q} hidden={{ aba }} />

      <Tabs
        items={[
          { value: "abertos", label: "Em aberto" },
          { value: "aprovados", label: "Aprovados" },
          { value: "convertidos", label: "Convertidos" },
          { value: "recusados", label: "Recusados" },
          { value: "todos", label: "Todos" },
        ]}
        current={aba}
        base={`/orcamentos${q ? `?q=${encodeURIComponent(q)}` : ""}`}
      />

      {rows.length === 0 ? (
        <Empty>Nenhum orçamento encontrado.</Empty>
      ) : (
        <div className="space-y-2">
          {rows.map((qt) => (
            <ListRow
              key={qt.id}
              href={`/orcamentos/${qt.id}`}
              badges={<StatusBadge defs={QUOTE_STATUS} value={qt.status} />}
              title={`${qt.number} - ${qt.customer_name}`}
              subtitle={qt.event_date ? `Evento em ${dateBR(qt.event_date)}` : "Sem data definida"}
              meta={qt.valid_until ? `Válido até ${dateBR(qt.valid_until)}` : undefined}
              right={<p className="text-sm font-bold">{money(qt.total_cents)}</p>}
            />
          ))}
        </div>
      )}

      <Pagination
        page={page}
        total={total}
        perPage={PER_PAGE}
        build={(p) => `/orcamentos?aba=${aba}&page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
      />
    </div>
  );
}
