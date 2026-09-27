import { all, scalar } from "@/lib/db";
import { CUSTOMER_SELECT } from "@/lib/queries";
import { cutoff3h, dateBR, money, phoneBR } from "@/lib/format";
import { Badge, Empty, LinkButton, PageHeader } from "@/components/ui";
import { ListRow, Pagination, SearchForm } from "@/components/List";

export const dynamic = "force-dynamic";
const PER_PAGE = 25;

export default async function ClientesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; inativos?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number(sp.page ?? 1));
  const inativos = sp.inativos === "1";

  const where: string[] = [];
  const params: any[] = [];
  if (!inativos) where.push("c.active = 1");
  if (q) {
    where.push("(c.name LIKE ? OR c.phone LIKE ? OR c.doc LIKE ? OR c.district LIKE ?)");
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  /* CUSTOMER_SELECT espera ?1 = corte das 3h (veja queries.ts): vem primeiro
     nos params, e os filtros do formulario entram depois. COUNT e listagem
     saem juntos (Promise.all): uma latencia so em vez de duas em sequencia. */
  const [total, rows] = await Promise.all([
    scalar<number>(`SELECT COUNT(*) FROM customers c ${clause}`, params),
    all<any>(
      `${CUSTOMER_SELECT} ${clause} ORDER BY c.name LIMIT ? OFFSET ?`,
      [cutoff3h(), ...params, PER_PAGE, (page - 1) * PER_PAGE],
    ),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Clientes"
        subtitle={`${total} cliente(s)`}
        action={<LinkButton href="/clientes/novo" variant="primario">+ Novo Cliente</LinkButton>}
      />

      <SearchForm action="/clientes" placeholder="Nome, telefone, CPF, bairro…" defaultValue={q}>
        <label className="flex items-center gap-2 rounded-xl border border-nuvem-300 bg-white px-3 py-2.5 text-sm">
          <input type="checkbox" name="inativos" value="1" defaultChecked={inativos} className="h-4 w-4" />
          Incluir inativos
        </label>
      </SearchForm>

      {rows.length === 0 ? (
        <Empty>Nenhum cliente encontrado.</Empty>
      ) : (
        <div className="space-y-2">
          {rows.map((c) => (
            <ListRow
              key={c.id}
              href={`/clientes/${c.id}`}
              badges={
                <>
                  {!c.active && <Badge tone="cinza">Inativo</Badge>}
                  {c.saldo_cents > 0 && <Badge tone="vermelho">Saldo {money(c.saldo_cents)}</Badge>}
                  {c.proxima && <Badge tone="verde">Próxima {dateBR(c.proxima)}</Badge>}
                </>
              }
              title={c.name}
              subtitle={[phoneBR(c.phone), c.district, c.city].filter(Boolean).join(" · ")}
              meta={`${c.locacoes} locação(ões) · total ${money(c.total_cents)}${c.ultima ? ` · última ${dateBR(c.ultima)}` : ""}`}
            />
          ))}
        </div>
      )}

      <Pagination
        page={page}
        total={total}
        perPage={PER_PAGE}
        build={(p) => `/clientes?page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}${inativos ? "&inativos=1" : ""}`}
      />
    </div>
  );
}
