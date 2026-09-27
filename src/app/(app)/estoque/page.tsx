import Link from "next/link";
import AvailabilityFilter from "@/components/AvailabilityFilter";
import { availabilityQuery, type AvailabilityParams } from "@/lib/availability-time";
import { stockOptions } from "@/lib/availability-settings";
import { all } from "@/lib/db";
import { availabilityAllWithKits } from "@/lib/stock";
import { money, today } from "@/lib/format";
import { Badge, Empty, LinkButton, PageHeader, Stat } from "@/components/ui";
import { Tabs } from "@/components/List";

export const dynamic = "force-dynamic";

export default async function EstoquePage({
  searchParams,
}: {
  searchParams: Promise<AvailabilityParams & { aba?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const aba = sp.aba ?? "todos";
  const query = availabilityQuery(sp);
  const options = await stockOptions(query);
  const disponibilidade = await availabilityAllWithKits(query.from, query.to, null, options);
  const produtos = await all<any>(
    `SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id
      ORDER BY p.active DESC, c.name, p.name`,
  );
  const info = new Map(disponibilidade.map((d) => [d.product_id, d]));

  const filtrados = produtos.filter((p) => {
    if (aba === "ativos") return p.active;
    if (aba === "inativos") return !p.active;
    if (aba === "kits") return p.kind === "kit";
    if (aba === "baixo") return info.get(p.id)?.low;
    if (aba === "manutencao") return p.maintenance_qty > 0;
    return true;
  });

  const categorias = [...new Set(filtrados.map((p) => p.category ?? "Sem categoria"))];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Estoque"
        subtitle={`${produtos.length} produto(s) cadastrado(s)`}
        action={
          <>
            <LinkButton href={`/disponibilidade?${query.queryString}`}>Consultar Disponibilidade</LinkButton>
            <LinkButton href="/estoque/novo" variant="primario">+ Novo Produto</LinkButton>
          </>
        }
      />

      <AvailabilityFilter query={query} minutes={options.preparationMinutes} hidden={{ aba }} />
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat
          label="Disponíveis na consulta"
          value={disponibilidade.filter((d) => d.kind !== "kit").reduce((s, d) => s + Math.max(0, d.available), 0)}
        />
        <Stat label="Reservados na consulta" value={disponibilidade.reduce((s, d) => s + d.reserved, 0)} />
        <Stat label="Kits cadastrados" value={produtos.filter((p) => p.kind === "kit").length} />
        <Stat label="Em manutenção" value={produtos.reduce((s, p) => s + p.maintenance_qty, 0)} />
        <Stat
          label="Abaixo do mínimo"
          value={disponibilidade.filter((d) => d.low).length}
          tone={disponibilidade.some((d) => d.low) ? "vermelho" : undefined}
        />
      </div>

      <Tabs
        items={[
          { value: "todos", label: "Todos" },
          { value: "ativos", label: "Ativos" },
          { value: "kits", label: "Kits" },
          { value: "baixo", label: "Estoque baixo" },
          { value: "manutencao", label: "Em manutenção" },
          { value: "inativos", label: "Inativos" },
        ]}
        current={aba}
        base={`/estoque?${query.queryString}`}
      />

      {filtrados.length === 0 ? (
        <Empty>Nenhum produto neste filtro.</Empty>
      ) : (
        categorias.map((cat) => (
          <section key={cat}>
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-stone-500">{cat}</h2>
            <div className="grid gap-2 sm:grid-cols-2">
              {filtrados
                .filter((p) => (p.category ?? "Sem categoria") === cat)
                .map((p) => {
                  const d = info.get(p.id);
                  return (
                    <Link key={p.id} href={`/estoque/${p.id}?${query.queryString}`} className="cartao flex items-center gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <div className="mb-1 flex flex-wrap gap-1.5">
                          {p.kind === "kit" && <Badge tone="terracota">Kit</Badge>}
                          {!p.active && <Badge tone="cinza">Inativo</Badge>}
                          {d?.low && <Badge tone="vermelho">Estoque baixo</Badge>}
                          {p.maintenance_qty > 0 && <Badge tone="roxo">{p.maintenance_qty} em manutenção</Badge>}
                        </div>
                        <p className="truncate text-sm font-bold text-tinta-900">{p.name}</p>
                        <p className="text-xs text-stone-500">
                          {p.code} · locação {money(p.rent_price_cents)}
                        </p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-lg font-bold leading-none text-tinta-900">
                          {d ? Math.max(0, d.available) : p.total_qty}
                        </p>
                        <p className="text-[0.65rem] uppercase text-stone-400">
                          {!p.active ? "estoque cadastrado (inativo)" : p.kind === "kit" ? "kits montáveis" : `de ${p.total_qty} na consulta`}
                        </p>
                      </div>
                    </Link>
                  );
                })}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
