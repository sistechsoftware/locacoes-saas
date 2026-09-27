import { all, scalar } from "@/lib/db";
import { FREIGHT_STATUS } from "@/lib/domain";
import { dateBR, money, timeBR } from "@/lib/format";
import { Empty, LinkButton, PageHeader, Stat, StatusBadge } from "@/components/ui";
import { ListRow, Pagination, SearchForm, Tabs } from "@/components/List";

export const dynamic = "force-dynamic";
const PER_PAGE = 20;

export default async function FretesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; aba?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const aba = sp.aba ?? "todos";
  const page = Math.max(1, Number(sp.page ?? 1));

  const where: string[] = [];
  const params: any[] = [];
  if (q) {
    where.push("(f.number LIKE ? OR f.contact_name LIKE ? OR c.name LIKE ? OR f.destination LIKE ? OR f.origin LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (aba !== "todos") {
    where.push("f.status = ?");
    params.push(aba);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await scalar<number>(
    `SELECT COUNT(*) FROM freights f LEFT JOIN customers c ON c.id = f.customer_id ${clause}`,
    params,
  );
  const rows = await all<any>(
    `SELECT f.*, c.name AS customer_name, v.name AS vehicle_name
       FROM freights f LEFT JOIN customers c ON c.id = f.customer_id LEFT JOIN vehicles v ON v.id = f.vehicle_id
     ${clause} ORDER BY f.date DESC, f.id DESC LIMIT ? OFFSET ?`,
    [...params, PER_PAGE, (page - 1) * PER_PAGE],
  );
  const faturado = await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM freights WHERE status = 'concluido'`);
  const agendados = await scalar<number>(`SELECT COUNT(*) FROM freights WHERE status IN ('agendado','em_rota')`);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Fretes"
        subtitle={`${total} frete(s)`}
        action={<LinkButton href="/fretes/novo" variant="primario">+ Novo Frete</LinkButton>}
      />

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Stat label="Total de fretes" value={total} />
        <Stat label="Agendados" value={agendados} />
        <Stat label="Faturado (concluídos)" value={money(faturado)} tone="verde" />
      </div>

      <SearchForm action="/fretes" placeholder="FRT-001, cliente, destino…" defaultValue={q} hidden={{ aba }} />
      <Tabs
        items={[{ value: "todos", label: "Todos" }, ...FREIGHT_STATUS.map((s) => ({ value: s.value, label: s.label }))]}
        current={aba}
        base={`/fretes${q ? `?q=${encodeURIComponent(q)}` : ""}`}
      />

      {rows.length === 0 ? (
        <Empty>Nenhum frete encontrado.</Empty>
      ) : (
        <div className="space-y-2">
          {rows.map((f) => (
            <ListRow
              key={f.id}
              href={`/fretes/${f.id}`}
              badges={<StatusBadge defs={FREIGHT_STATUS} value={f.status} />}
              title={`${f.number} - ${f.customer_name ?? f.contact_name ?? "Sem cliente"}`}
              subtitle={`${dateBR(f.date)}${f.time ? ` às ${timeBR(f.time)}` : ""} · ${f.origin ?? "?"} até ${f.destination ?? "?"}`}
              meta={f.cargo}
              right={<p className="text-sm font-bold">{money(f.amount_cents)}</p>}
            />
          ))}
        </div>
      )}

      <Pagination
        page={page}
        total={total}
        perPage={PER_PAGE}
        build={(p) => `/fretes?aba=${aba}&page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
      />
    </div>
  );
}
