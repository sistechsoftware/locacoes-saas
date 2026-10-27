import Link from "next/link";
import { requireModule } from "@/lib/auth";
import { temRecurso, bloquearRecurso, registrarNegacao } from "@/lib/plano-gate";
import { listarPedidos, lojaDaEmpresa } from "@/lib/loja-db";
import { ESTADOS_PEDIDO, ESTADOS_PAGAMENTO } from "@/lib/loja";
import { Badge, Empty, PageHeader, Section, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

const money = (c: number) => `R$ ${(Number(c || 0) / 100).toFixed(2).replace(".", ",")}`;

const FILTROS = [
  { v: "", label: "Todos" },
  { v: "pendentes", label: "Pendentes" },
  { v: "comprovantes", label: "Comprovantes" },
  { v: "confirmados", label: "Confirmados" },
  { v: "encerrados", label: "Encerrados" },
];

export default async function PedidosLojaPage({ searchParams }: { searchParams: Promise<{ filtro?: string }> }) {
  const ctx = await requireModule("configuracoes");
  if (!(await temRecurso(ctx.user, "loja_virtual"))) {
    registrarNegacao(ctx.companyId, "loja_virtual", "pagina-loja");
    bloquearRecurso("loja_virtual", ctx.user, "pagina");
  }
  const { filtro = "" } = await searchParams;
  const [loja, pedidos] = await Promise.all([lojaDaEmpresa(ctx.companyId), listarPedidos(ctx.companyId, filtro)]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pedidos recebidos"
        subtitle="Toda solicitação enviada pela loja, com origem, cliente, itens, frete e pagamentos."
        action={
          loja?.status === "publicada" ? (
            <Badge tone="verde">loja no ar: /loja/{loja.slug}</Badge>
          ) : (
            <Badge tone="cinza">loja fora do ar</Badge>
          )
        }
      />

      <nav className="flex flex-wrap gap-2">
        {FILTROS.map((f) => (
          <Link
            key={f.v}
            href={`/configuracoes/loja/pedidos${f.v ? `?filtro=${f.v}` : ""}`}
            className={`rounded-full px-3 py-1.5 text-sm font-semibold ${
              filtro === f.v ? "bg-marca-600 text-white" : "border border-nuvem-300 bg-white text-stone-600 hover:bg-nuvem-50"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      <Section title="Solicitações">
        {pedidos.length === 0 ? (
          <Empty>Nenhuma solicitação neste filtro.</Empty>
        ) : (
          <ul className="divide-y divide-nuvem-200">
            {pedidos.map((p) => (
              <li key={p.id}>
                <Link href={`/configuracoes/loja/pedidos/${p.id}`} className="flex flex-wrap items-center justify-between gap-2 py-3 hover:bg-nuvem-50">
                  <span className="min-w-0">
                    <span className="block font-semibold text-tinta-900">
                      {p.number} · {p.customer_name}
                    </span>
                    <span className="block text-xs text-stone-500">
                      {p.event_date.split("-").reverse().join("/")} · {p.item_count} item(ns) ·{" "}
                      {p.kind === "orcamento" ? "orçamento" : "reserva"} · {p.created_at}
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="text-sm font-bold text-tinta-900">{money(p.total_cents)}</span>
                    <StatusBadge defs={ESTADOS_PEDIDO} value={p.status} />
                    {p.payment_status !== "nao_informado" && <StatusBadge defs={ESTADOS_PAGAMENTO} value={p.payment_status} />}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
