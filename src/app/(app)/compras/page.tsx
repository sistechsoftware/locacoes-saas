import { all, scalar } from "@/lib/db";
import { PURCHASE_SELECT } from "@/lib/compras";
import { dateBR, money } from "@/lib/format";
import { Badge, Empty, LinkButton, PageHeader, Stat } from "@/components/ui";
import { ListRow, Pagination, SearchForm, Tabs } from "@/components/List";

export const dynamic = "force-dynamic";
const PER_PAGE = 20;

export default async function ComprasPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; aba?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const aba = sp.aba ?? "todas";
  const page = Math.max(1, Number(sp.page ?? 1));

  const where: string[] = [];
  const params: any[] = [];
  if (q) {
    where.push("(p.number LIKE ? OR s.name LIKE ? OR p.notes LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (aba === "estoque") where.push("p.affects_stock = 1 AND p.status <> 'cancelada'");
  else if (aba === "historicas") where.push("p.affects_stock = 0 AND p.status <> 'cancelada'");
  else if (aba === "canceladas") where.push("p.status = 'cancelada'");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [total, rows, resumo] = await Promise.all([
    scalar<number>(`SELECT COUNT(*) FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id ${clause}`, params),
    all<any>(`${PURCHASE_SELECT} ${clause} ORDER BY p.purchase_date DESC, p.id DESC LIMIT ? OFFSET ?`, [
      ...params,
      PER_PAGE,
      (page - 1) * PER_PAGE,
    ]),
    all<any>(
      `SELECT COALESCE(SUM(total_cents),0) AS total,
              COALESCE(SUM(CASE WHEN kind = 'investimento' THEN total_cents END),0) AS investido
         FROM purchases WHERE status <> 'cancelada'`,
    ),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Compras"
        subtitle={`${total} compra(s)`}
        action={<LinkButton href="/compras/nova" variant="primario">+ Nova Compra</LinkButton>}
      />

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Stat label="Total comprado" value={money(resumo[0]?.total ?? 0)} />
        <Stat label="Investido em estrutura" value={money(resumo[0]?.investido ?? 0)} />
        <Stat label="Compras" value={total} />
      </div>

      <SearchForm action="/compras" placeholder="COMP-001, fornecedor…" defaultValue={q} hidden={{ aba }} />
      <Tabs
        items={[
          { value: "todas", label: "Todas" },
          { value: "estoque", label: "Movimentaram estoque" },
          { value: "historicas", label: "Históricas" },
          { value: "canceladas", label: "Canceladas" },
        ]}
        current={aba}
        base={`/compras${q ? `?q=${encodeURIComponent(q)}` : ""}`}
      />

      {rows.length === 0 ? (
        <Empty>Nenhuma compra encontrada.</Empty>
      ) : (
        <div className="space-y-2">
          {rows.map((c) => {
            const saldo = c.total_cents - c.pago_cents;
            return (
              <ListRow
                key={c.id}
                href={`/compras/${c.id}`}
                badges={
                  <>
                    {c.status === "cancelada" && <Badge tone="vermelho">Cancelada</Badge>}
                    {c.affects_stock ? <Badge tone="azul">Entrou no estoque</Badge> : <Badge tone="cinza">Histórica</Badge>}
                    {c.kind === "investimento" && <Badge tone="terracota">Investimento</Badge>}
                    {c.status !== "cancelada" &&
                      (saldo > 0 ? <Badge tone="ambar">A pagar {money(saldo)}</Badge> : <Badge tone="verde">Paga</Badge>)}
                  </>
                }
                title={`${c.number} - ${c.supplier_name ?? "Sem fornecedor"}`}
                subtitle={`${dateBR(c.purchase_date)} · ${c.item_qty} item(ns)`}
                meta={c.parcelas > 1 ? `${c.parcelas} parcelas` : "à vista"}
                right={<p className="text-sm font-bold">{money(c.total_cents)}</p>}
              />
            );
          })}
        </div>
      )}

      <Pagination
        page={page}
        total={total}
        perPage={PER_PAGE}
        build={(p) => `/compras?aba=${aba}&page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
      />
    </div>
  );
}
