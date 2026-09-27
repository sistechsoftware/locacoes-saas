import { all, scalar } from "@/lib/db";
import { CONTRACT_STATUS } from "@/lib/domain";
import { dateBR, money } from "@/lib/format";
import { Empty, PageHeader, StatusBadge } from "@/components/ui";
import { ListRow, Pagination, SearchForm, Tabs } from "@/components/List";

export const dynamic = "force-dynamic";
const PER_PAGE = 20;

export default async function ContratosPage({
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
    where.push("(ct.number LIKE ? OR r.number LIKE ? OR c.name LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (aba !== "todos") {
    where.push("ct.status = ?");
    params.push(aba);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const base = `FROM contracts ct JOIN reservations r ON r.id = ct.reservation_id JOIN customers c ON c.id = r.customer_id`;
  const total = await scalar<number>(`SELECT COUNT(*) ${base} ${clause}`, params);
  const rows = await all<any>(
    `SELECT ct.*, r.number AS reservation_number, r.event_date, r.total_cents, c.name AS customer_name
     ${base} ${clause} ORDER BY ct.id DESC LIMIT ? OFFSET ?`,
    [...params, PER_PAGE, (page - 1) * PER_PAGE],
  );

  return (
    <div className="space-y-4">
      <PageHeader title="Contratos" subtitle={`${total} contrato(s)`} />
      <SearchForm action="/contratos" placeholder="CTR-001, LIMA-001, cliente…" defaultValue={q} hidden={{ aba }} />
      <Tabs
        items={[{ value: "todos", label: "Todos" }, ...CONTRACT_STATUS.map((s) => ({ value: s.value, label: s.label }))]}
        current={aba}
        base={`/contratos${q ? `?q=${encodeURIComponent(q)}` : ""}`}
      />

      {rows.length === 0 ? (
        <Empty>
          Nenhum contrato encontrado. Gere o contrato a partir da página de uma reserva.
        </Empty>
      ) : (
        <div className="space-y-2">
          {rows.map((c) => (
            <ListRow
              key={c.id}
              href={`/contratos/${c.id}`}
              badges={<StatusBadge defs={CONTRACT_STATUS} value={c.status} />}
              title={`${c.number} - ${c.customer_name}`}
              subtitle={`${c.reservation_number} - evento em ${dateBR(c.event_date)}`}
              right={<p className="text-sm font-bold">{money(c.total_cents)}</p>}
            />
          ))}
        </div>
      )}

      <Pagination
        page={page}
        total={total}
        perPage={PER_PAGE}
        build={(p) => `/contratos?aba=${aba}&page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
      />
    </div>
  );
}
