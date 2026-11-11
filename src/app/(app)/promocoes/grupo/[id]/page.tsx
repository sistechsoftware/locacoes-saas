import { notFound } from "next/navigation";
import Link from "next/link";
import { requireModule } from "@/lib/auth";
import { ehAdmin } from "@/lib/roles";
import { getGrupo } from "@/lib/promocoes-db";
import { rotuloFaixa, validarFaixas, vigente } from "@/lib/promocoes";
import { logsFor } from "@/lib/audit";
import { dateBR, money, today, utcParaLocal } from "@/lib/format";
import { Alerta, Badge, Card, LinkButton, PageHeader, Section, Stat } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { deleteGroupPromotion, toggleGroupPromotion } from "../../actions";

export const dynamic = "force-dynamic";

export default async function PromocaoGrupoPage({ params }: { params: Promise<{ id: string }> }) {
  const { user } = await requireModule("promocoes");
  const { id } = await params;
  const grupo = await getGrupo(Number(id));
  if (!grupo) notFound();

  const historico = await logsFor("promocao_grupo", grupo.id);
  const d0 = today();
  const valendo = vigente({ active: grupo.active, starts_on: grupo.starts_on, ends_on: grupo.ends_on }, d0);
  const avisos = grupo.tiers.length ? validarFaixas(grupo.tiers).filter((p) => p.tipo === "aviso") : [];
  const menorPreco = grupo.tiers.length ? Math.min(...grupo.tiers.map((f) => f.unit_price_cents)) : 0;
  const ultima = grupo.tiers[grupo.tiers.length - 1];

  return (
    <div className="space-y-4">
      <PageHeader
        title={grupo.name || "Promoção em grupo"}
        subtitle={`${grupo.promotions.length} produto(s) com a mesma regra`}
        action={
          ehAdmin(user.role) ? (
            <LinkButton href={`/promocoes/grupo/${grupo.id}/editar`}>Editar</LinkButton>
          ) : undefined
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          {grupo.active ? <Badge tone="verde">Ativa</Badge> : <Badge tone="cinza">Inativa</Badge>}
          {grupo.active && !valendo && <Badge tone="ambar">Fora do período hoje</Badge>}
          <Badge tone="cinza">
            {grupo.starts_on || grupo.ends_on
              ? `${grupo.starts_on ? dateBR(grupo.starts_on) : "sempre"} até ${grupo.ends_on ? dateBR(grupo.ends_on) : "sem fim"}`
              : "Sem período definido"}
          </Badge>
          <Badge tone="azul">Grupo · {grupo.promotions.length} produtos</Badge>
        </div>
        {grupo.notes && <p className="mt-2 text-sm text-stone-600">{grupo.notes}</p>}
      </Card>

      {!valendo && grupo.active && (
        <Alerta tone="ambar" title="Não está valendo hoje">
          A promoção está ativa, mas fora do período configurado. Orçamentos e reservas de hoje usam o preço normal de
          cada produto.
        </Alerta>
      )}
      {!grupo.active && (
        <Alerta tone="ambar" title="Promoção desativada">
          O sistema está usando o preço normal de cada produto. Documentos já salvos com o preço promocional continuam
          com o valor que foi registrado.
        </Alerta>
      )}
      {avisos.length > 0 && (
        <Alerta tone="ambar" title="Quantidades sem promoção">
          <ul className="list-disc pl-4">
            {avisos.map((p, i) => (
              <li key={i}>{p.mensagem}</li>
            ))}
          </ul>
        </Alerta>
      )}

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <Stat label="Produtos no grupo" value={grupo.promotions.length} />
        <Stat label="Menor preço promocional" value={money(menorPreco)} tone="verde" />
        <Stat label="Faixas" value={grupo.tiers.length} />
      </div>

      {grupo.tiers.length > 0 && (
        <Section title="Faixas de Preço">
          <div className="scroll-x">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-nuvem-200 text-left text-xs uppercase text-stone-500">
                  <th className="py-2">De</th>
                  <th className="py-2">Até</th>
                  <th className="py-2">Preço por unidade</th>
                  <th className="py-2 text-right">Exemplo</th>
                </tr>
              </thead>
              <tbody>
                {grupo.tiers.map((f, i) => (
                  <tr key={i} className="border-b border-nuvem-100">
                    <td className="py-2 font-semibold">{f.min_qty}</td>
                    <td className="py-2">{f.max_qty === null ? "sem limite" : f.max_qty}</td>
                    <td className="py-2 font-bold text-tinta-900">{money(f.unit_price_cents)}</td>
                    <td className="py-2 text-right text-stone-500">
                      {f.min_qty} un. = {money(f.min_qty * f.unit_price_cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ultima && (
            <p className="mt-2 text-xs text-stone-500">
              O preço da faixa alcançada vale para todas as unidades do item. {rotuloFaixa(ultima)} sai por{" "}
              {money(ultima.unit_price_cents)} cada.
            </p>
          )}
          <p className="mt-1 text-xs text-stone-500">
            Cada produto calcula pela <b>própria</b> quantidade: quantidades de produtos diferentes não são somadas
            para alcançar uma faixa.
          </p>
        </Section>
      )}

      <Section title="Produtos do grupo">
        <div className="scroll-x">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-nuvem-200 text-left text-xs uppercase text-stone-500">
                <th className="py-2">Produto</th>
                <th className="py-2">Código</th>
                <th className="py-2 text-right">Preço normal</th>
              </tr>
            </thead>
            <tbody>
              {grupo.promotions.map((p) => (
                <tr key={p.id} className="border-b border-nuvem-100">
                  <td className="py-2">
                    <Link href={`/estoque/${p.product_id}`} className="font-semibold text-marca-600">
                      {p.product_name}
                    </Link>
                  </td>
                  <td className="py-2 text-stone-500">{p.product_code}</td>
                  <td className="py-2 text-right text-stone-600">{money(p.rent_price_cents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-stone-500">
          Remover um produto do grupo devolve a ele o preço normal; desmarcar não apaga nenhum documento já salvo.
        </p>
      </Section>

      <Card>
        <p className="text-sm text-stone-600">
          Vale para os produtos acima em orçamentos, reservas e pedidos novos. Frete, montagem e outros serviços não são
          afetados, e o desconto manual continua funcionando por cima do preço promocional.
        </p>
      </Card>

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

      {ehAdmin(user.role) && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-tinta-900">Área do administrador</p>
            <p className="text-xs text-stone-500">
              Ativar/desativar vale para o grupo inteiro. Excluir apaga a regra, e nenhum documento já salvo muda de
              valor.
            </p>
          </div>
          <div className="flex gap-2">
            <form action={toggleGroupPromotion}>
              <input type="hidden" name="id" value={grupo.id} />
              <SubmitButton variant="secundario">{grupo.active ? "Desativar" : "Ativar"}</SubmitButton>
            </form>
            <form action={deleteGroupPromotion}>
              <input type="hidden" name="id" value={grupo.id} />
              <SubmitButton
                variant="perigo"
                confirm="Excluir esta promoção em grupo? Os documentos já salvos mantêm os valores."
              >
                Excluir
              </SubmitButton>
            </form>
          </div>
        </Card>
      )}
    </div>
  );
}
