import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getPromocao } from "@/lib/promocoes-db";
import { rotuloFaixa, validarFaixas, vigente } from "@/lib/promocoes";
import { logsFor } from "@/lib/audit";
import { dateBR, money, today, utcParaLocal } from "@/lib/format";
import { Alerta, Badge, Card, LinkButton, PageHeader, Section, Stat } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { deletePromotion, togglePromotion } from "../actions";

export const dynamic = "force-dynamic";

export default async function PromocaoPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const promocao = await getPromocao(Number(id));
  if (!promocao) notFound();

  const historico = await logsFor("promocao", promocao.id);
  const d0 = today();
  const valendo = vigente(promocao, d0);
  const avisos = validarFaixas(promocao.tiers).filter((p) => p.tipo === "aviso");
  const menorPreco = Math.min(...promocao.tiers.map((f) => f.unit_price_cents));

  return (
    <div className="space-y-4">
      <PageHeader
        title={promocao.name || `Promoção de ${promocao.product_name}`}
        subtitle={promocao.product_name}
        action={
          user.role === "admin" ? (
            <LinkButton href={`/promocoes/${promocao.id}/editar`}>Editar</LinkButton>
          ) : undefined
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          {promocao.active ? <Badge tone="verde">Ativa</Badge> : <Badge tone="cinza">Inativa</Badge>}
          {promocao.active && !valendo && <Badge tone="ambar">Fora do período hoje</Badge>}
          <Badge tone="cinza">
            {promocao.starts_on || promocao.ends_on
              ? `${promocao.starts_on ? dateBR(promocao.starts_on) : "sempre"} até ${promocao.ends_on ? dateBR(promocao.ends_on) : "sem fim"}`
              : "Sem período definido"}
          </Badge>
        </div>
        {promocao.notes && <p className="mt-2 text-sm text-stone-600">{promocao.notes}</p>}
      </Card>

      {!valendo && promocao.active && (
        <Alerta tone="ambar" title="Não está valendo hoje">
          A promoção está ativa, mas fora do período configurado. Orçamentos e reservas de hoje usam o preço normal de{" "}
          {money(promocao.rent_price_cents)}.
        </Alerta>
      )}
      {!promocao.active && (
        <Alerta tone="ambar" title="Promoção desativada">
          O sistema está usando o preço normal de {money(promocao.rent_price_cents)}. Documentos já salvos com o preço
          promocional continuam com o valor que foi registrado.
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
        <Stat label="Preço normal" value={money(promocao.rent_price_cents)} />
        <Stat label="Menor preço promocional" value={money(menorPreco)} tone="verde" />
        <Stat label="Faixas" value={promocao.tiers.length} />
      </div>

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
              {promocao.tiers.map((f, i) => (
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
        <p className="mt-2 text-xs text-stone-500">
          O preço da faixa alcançada vale para todas as unidades do item. {rotuloFaixa(promocao.tiers[promocao.tiers.length - 1])}{" "}
          sai por {money(promocao.tiers[promocao.tiers.length - 1].unit_price_cents)} cada.
        </p>
      </Section>

      <Card>
        <p className="text-sm text-stone-600">
          Vale para <Link href={`/estoque/${promocao.product_id}`} className="font-semibold text-marca-600">{promocao.product_name}</Link>{" "}
          em orçamentos, reservas e pedidos novos. Frete, montagem e outros serviços não são afetados, e o desconto
          manual continua funcionando por cima do preço promocional.
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

      {user.role === "admin" && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-tinta-900">Área do administrador</p>
            <p className="text-xs text-stone-500">
              Desativar mantém o cadastro e volta ao preço normal. Excluir apaga a regra, e nenhum documento já salvo
              muda de valor.
            </p>
          </div>
          <div className="flex gap-2">
            <form action={togglePromotion}>
              <input type="hidden" name="id" value={promocao.id} />
              <SubmitButton variant="secundario">{promocao.active ? "Desativar" : "Ativar"}</SubmitButton>
            </form>
            <form action={deletePromotion}>
              <input type="hidden" name="id" value={promocao.id} />
              <SubmitButton variant="perigo" confirm="Excluir esta promoção? Os documentos já salvos mantêm os valores.">
                Excluir
              </SubmitButton>
            </form>
          </div>
        </Card>
      )}
    </div>
  );
}
