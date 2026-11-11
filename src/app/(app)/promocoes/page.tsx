import { requireModule } from "@/lib/auth";
import { listarPromocoes } from "@/lib/promocoes-db";
import { rotuloFaixa, vigente } from "@/lib/promocoes";
import { dateBR, money, today } from "@/lib/format";
import { Badge, Empty, LinkButton, PageHeader } from "@/components/ui";
import { ListRow, SearchForm, Tabs } from "@/components/List";

export const dynamic = "force-dynamic";

const SITUACOES = [
  { value: "todas", label: "Todas" },
  { value: "ativas", label: "Ativas" },
  { value: "inativas", label: "Inativas" },
];

type LinhaLista = {
  chave: string;
  href: string;
  promocao: Awaited<ReturnType<typeof listarPromocoes>>[number];
  grupo?: { id: number; nome: string; total: number };
};

export default async function PromocoesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; situacao?: string }>;
}) {
  await requireModule("promocoes");
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const situacao = sp.situacao ?? "todas";
  const promocoes = await listarPromocoes({ busca: q, situacao });
  const d0 = today();

  // Promoção em grupo é N linhas no banco (uma por produto). Na lista ela
  // aparece UMA vez, com o total de produtos — senão selecionar "todos os
  // forros" transformaria a tela numa lista de forros repetidos.
  const linhas: LinhaLista[] = [];
  const gruposVistos = new Set<number>();
  for (const p of promocoes) {
    const grupoId = p.group_id ?? null;
    if (grupoId) {
      if (gruposVistos.has(grupoId)) continue;
      gruposVistos.add(grupoId);
      linhas.push({
        chave: `g${grupoId}`,
        href: `/promocoes/grupo/${grupoId}`,
        promocao: p,
        grupo: { id: grupoId, nome: p.group_name || "Promoção em grupo", total: Number(p.group_size) || 1 },
      });
    } else {
      linhas.push({ chave: `p${p.id}`, href: `/promocoes/${p.id}`, promocao: p });
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Promoções por Quantidade"
        subtitle={`${linhas.length} promoção(ões)`}
        action={<LinkButton href="/promocoes/nova" variant="primario">+ Nova Promoção</LinkButton>}
      />

      <SearchForm action="/promocoes" placeholder="Produto ou nome da promoção…" defaultValue={q} />
      <Tabs items={SITUACOES} current={situacao} base="/promocoes" param="situacao" />

      {linhas.length === 0 ? (
        <Empty>
          Nenhuma promoção cadastrada. Enquanto não houver, todo produto usa o preço normal do cadastro.
        </Empty>
      ) : (
        <div className="space-y-2">
          {linhas.map(({ chave, href, promocao: p, grupo }) => {
            const valendo = vigente(p, d0);
            const periodo =
              p.starts_on || p.ends_on
                ? `${p.starts_on ? dateBR(p.starts_on) : "sempre"} até ${p.ends_on ? dateBR(p.ends_on) : "sem fim"}`
                : "sem período definido";
            return (
              <ListRow
                key={chave}
                href={href}
                badges={
                  <>
                    {p.active ? <Badge tone="verde">Ativa</Badge> : <Badge tone="cinza">Inativa</Badge>}
                    {p.active && !valendo && <Badge tone="ambar">Fora do período</Badge>}
                    {grupo && <Badge tone="azul">Grupo · {grupo.total} produtos</Badge>}
                  </>
                }
                title={grupo ? grupo.nome : p.name || p.product_name}
                subtitle={
                  grupo
                    ? `${grupo.total} produto(s) · ${periodo}`
                    : `${p.product_name} · normal ${money(p.rent_price_cents)} · ${periodo}`
                }
                body={
                  <ul className="space-y-0.5 text-xs">
                    {p.tiers.map((f, i) => (
                      <li key={i} className="flex justify-between gap-3">
                        <span className="text-stone-500">{rotuloFaixa(f)}</span>
                        <span className="font-semibold text-tinta-900">{money(f.unit_price_cents)} cada</span>
                      </li>
                    ))}
                  </ul>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
