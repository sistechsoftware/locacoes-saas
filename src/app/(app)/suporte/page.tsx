import Link from "next/link";
import { requireModule } from "@/lib/auth";
import { listarChamados, labelCategoria, prioridadeDaEmpresa, STATUS_CHAMADO } from "@/lib/suporte";
import { Alerta, Badge, Card, Empty, LinkButton, PageHeader, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

function dataHoraBR(sql: string | null) {
  if (!sql) return "—";
  const [dia, hora] = sql.slice(0, 16).split(" ");
  return `${dia.split("-").reverse().join("/")}${hora ? ` ${hora}` : ""}`;
}

/**
 * Suporte — FUNDAMENTAL: todo plano abre e acompanha chamados (o que é
 * exclusivo do Empresarial é o NÍVEL prioritário da fila, exibido aqui como
 * selo quando o recurso `suporte` está liberado para a empresa).
 */
export default async function SuportePage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string; erro?: string }>;
}) {
  const { user } = await requireModule("suporte");
  const sp = await searchParams;
  const incluirResolvidos = sp.aba === "todos";
  const [chamados, prioridade] = await Promise.all([
    listarChamados(user.company_id, { incluirResolvidos }),
    prioridadeDaEmpresa(user.company_id),
  ]);
  const prioritario = prioridade === "prioritario";

  return (
    <div className="space-y-4">
      <PageHeader
        title="Suporte"
        subtitle="Abra chamados, acompanhe as respostas e resolva problemas com a equipe Locô."
        action={
          <LinkButton href="/suporte/novo" variant="primario">
            Novo chamado
          </LinkButton>
        }
      />

      {sp.erro && <Alerta tone="vermelho">{sp.erro}</Alerta>}

      {prioritario && (
        <Alerta tone="azul" title="Suporte prioritário ativo">
          Seu plano inclui suporte prioritário: seus chamados entram no topo da fila da nossa equipe, com resposta em
          primeiro lugar.
        </Alerta>
      )}

      <div className="flex gap-2 text-sm">
        <Link
          href="/suporte"
          className={`rounded-xl border px-3 py-1.5 ${!incluirResolvidos ? "border-marca-300 bg-marca-50 font-semibold text-marca-700" : "border-nuvem-300 bg-white text-stone-600"}`}
        >
          Abertos
        </Link>
        <Link
          href="/suporte?aba=todos"
          className={`rounded-xl border px-3 py-1.5 ${incluirResolvidos ? "border-marca-300 bg-marca-50 font-semibold text-marca-700" : "border-nuvem-300 bg-white text-stone-600"}`}
        >
          Todos
        </Link>
      </div>

      {chamados.length === 0 ? (
        <Empty>
          {incluirResolvidos
            ? "Nenhum chamado ainda."
            : "Nenhum chamado aberto. Problema, dúvida ou sugestão? Abra um chamado — a gente responde por aqui."}
        </Empty>
      ) : (
        <div className="space-y-2">
          {chamados.map((c) => (
            <Link key={c.id} href={`/suporte/${c.id}`} className="cartao block p-4 transition hover:border-marca-300">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-stone-400">#{c.id}</span>
                <StatusBadge defs={STATUS_CHAMADO} value={c.status} />
                <Badge tone="cinza">{labelCategoria(c.category)}</Badge>
                {prioritario && <Badge tone="terracota">Prioritário</Badge>}
                {!!c.nao_lidas && <Badge tone="azul">{c.nao_lidas} nova(s)</Badge>}
                <span className="ml-auto text-xs text-stone-400">{dataHoraBR(c.updated_at)}</span>
              </div>
              <p className="mt-2 text-sm font-semibold text-tinta-900">{c.subject}</p>
            </Link>
          ))}
        </div>
      )}

      <Card className="text-sm text-stone-500">
        O suporte cobre erros, cobrança/assinatura, dúvidas de uso e sugestões. Para diagnóstico técnico detalhado, o{" "}
        <Link href="/erros" className="text-marca-600 underline">
          Diário de erros
        </Link>{" "}
        da empresa mostra o que aconteceu no servidor.
      </Card>
    </div>
  );
}
