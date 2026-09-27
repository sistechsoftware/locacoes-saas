import { all, scalar } from "@/lib/db";
import { RESERVATION_SELECT, itemsForReservations } from "@/lib/reservations";
import { RESERVATION_STATUS } from "@/lib/domain";
import { addDays, dateBR, money, startOfWeek, today } from "@/lib/format";
import { Badge, Empty, LinkButton, PageHeader, StatusBadge } from "@/components/ui";
import { ListRow, Pagination, SearchForm, Tabs } from "@/components/List";
import { ReservationItems } from "@/components/ReservationItems";

export const dynamic = "force-dynamic";
const PER_PAGE = 20;

const PERIODOS = [
  { value: "todas", label: "Todas" },
  { value: "hoje", label: "Hoje" },
  { value: "semana", label: "Semana" },
  { value: "futuras", label: "Futuras" },
  { value: "passadas", label: "Passadas" },
];

export default async function ReservasPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; periodo?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const status = sp.status ?? "";
  const periodo = sp.periodo ?? "todas";
  const page = Math.max(1, Number(sp.page ?? 1));
  const d0 = today();

  const where: string[] = [];
  const params: any[] = [];

  if (q) {
    where.push("(r.number LIKE ? OR c.name LIKE ? OR r.address LIKE ? OR r.district LIKE ? OR c.phone LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (status) {
    where.push("r.status = ?");
    params.push(status);
  }
  if (periodo === "hoje") {
    where.push("r.event_date = ?");
    params.push(d0);
  } else if (periodo === "semana") {
    where.push("r.event_date BETWEEN ? AND ?");
    params.push(startOfWeek(d0), addDays(startOfWeek(d0), 6));
  } else if (periodo === "futuras") {
    where.push("r.event_date >= ?");
    params.push(d0);
  } else if (periodo === "passadas") {
    where.push("r.event_date < ?");
    params.push(d0);
  }

  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = await scalar<number>(
    `SELECT COUNT(*) FROM reservations r JOIN customers c ON c.id = r.customer_id ${clause}`,
    params,
  );
  const rows = await all<any>(
    `${RESERVATION_SELECT} ${clause} ORDER BY r.event_date DESC, r.id DESC LIMIT ? OFFSET ?`,
    [...params, PER_PAGE, (page - 1) * PER_PAGE],
  );

  // itens de todas as reservas da pagina em duas consultas, nao uma por cartao
  const itensPorReserva = await itemsForReservations(rows.map((r) => r.id));

  const base = `/reservas?${new URLSearchParams({ ...(q ? { q } : {}), ...(status ? { status } : {}) }).toString()}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reservas"
        subtitle={`${total} reserva(s)`}
        action={<LinkButton href="/reservas/nova" variant="primario">+ Nova Reserva</LinkButton>}
      />

      <SearchForm action="/reservas" placeholder="LIMA-001, cliente, endereço…" defaultValue={q}>
        {/* min-w-0: dentro do flex do SearchForm, deixa o select encolher no
            celular sem empurrar o campo de busca para fora da tela */}
        <select name="status" defaultValue={status} className="campo min-w-[9rem] basis-36 sm:w-auto">
          <option value="">Todos os status</option>
          {RESERVATION_STATUS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </SearchForm>

      <Tabs items={PERIODOS} current={periodo} base={base} param="periodo" />

      {rows.length === 0 ? (
        <Empty>Nenhuma reserva encontrada.</Empty>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => {
            const saldo = r.total_cents - r.paid_cents;
            return (
              <ListRow
                key={r.id}
                href={`/reservas/${r.id}`}
                badges={
                  <>
                    <StatusBadge defs={RESERVATION_STATUS} value={r.status} />
                    {saldo > 0 && r.status !== "cancelada" && <Badge tone="vermelho">Saldo {money(saldo)}</Badge>}
                    {saldo <= 0 && r.total_cents > 0 && <Badge tone="verde">Pago</Badge>}
                  </>
                }
                title={`${r.number} - ${r.customer_name}`}
                subtitle={`${dateBR(r.event_date)}${r.event_time ? ` às ${r.event_time}` : ""}`}
                meta={[r.address, r.district].filter(Boolean).join(", ")}
                right={<p className="text-sm font-bold">{money(r.total_cents)}</p>}
                body={<ReservationItems items={itensPorReserva.get(r.id) ?? []} />}
              />
            );
          })}
        </div>
      )}

      <Pagination
        page={page}
        total={total}
        perPage={PER_PAGE}
        build={(p) =>
          `/reservas?${new URLSearchParams({
            ...(q ? { q } : {}),
            ...(status ? { status } : {}),
            periodo,
            page: String(p),
          }).toString()}`
        }
      />
    </div>
  );
}
