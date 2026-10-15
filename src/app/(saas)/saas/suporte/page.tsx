import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/auth";
import { filaPlataforma, labelCategoria, resumoFila, STATUS_CHAMADO } from "@/lib/suporte";
import { Badge, Empty, PageHeader, StatusBadge } from "@/components/ui";

export const dynamic = "force-dynamic";

function dataHoraBR(sql: string | null) {
  if (!sql) return "—";
  const [dia, hora] = sql.slice(0, 16).split(" ");
  return `${dia.split("-").reverse().join("/")}${hora ? ` ${hora}` : ""}`;
}

function abaAtiva(atual: string, esta: string) {
  return atual === esta
    ? "border-marca-300 bg-marca-50 font-semibold text-marca-700"
    : "border-nuvem-300 bg-white text-stone-600";
}

/**
 * Fila única de suporte de TODAS as empresas. A ordem vem da prioridade AO
 * VIVO da matriz (recursoLiberado por empresa) — Empresariais (ou com
 * cortesia/liberação) primeiro, mais antigo primeiro dentro da banda.
 * Guard redundante ao layout do grupo (saas), mesmo padrão das demais telas.
 */
export default async function SaasSuportePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; erro?: string }>;
}) {
  await requirePlatformAdmin();
  const sp = await searchParams;
  const status = sp.status === "todos" || sp.status === "resolvido" ? sp.status : "abertos";
  const [fila, resumo] = await Promise.all([filaPlataforma({ status }), resumoFila()]);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Suporte"
        subtitle={`${resumo.abertos} aberto(s) · ${resumo.prioritarios} prioritário(s) · ${resumo.aguardando} aguardando a empresa`}
      />

      <div className="flex flex-wrap gap-2 text-sm">
        <Link href="/saas/suporte" className={`rounded-xl border px-3 py-1.5 ${abaAtiva(status, "abertos")}`}>
          Abertos
        </Link>
        <Link href="/saas/suporte?status=resolvido" className={`rounded-xl border px-3 py-1.5 ${abaAtiva(status, "resolvido")}`}>
          Resolvidos
        </Link>
        <Link href="/saas/suporte?status=todos" className={`rounded-xl border px-3 py-1.5 ${abaAtiva(status, "todos")}`}>
          Todos
        </Link>
      </div>

      {fila.length === 0 ? (
        <Empty>Nenhum chamado nesta aba. 🎉</Empty>
      ) : (
        <div className="space-y-2">
          {fila.map((c) => (
            <Link
              key={c.id}
              href={`/saas/suporte/${c.id}`}
              className="cartao block p-4 transition hover:border-marca-300"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold text-stone-400">#{c.id}</span>
                <StatusBadge defs={STATUS_CHAMADO} value={c.status} />
                {c.prioridade_viva === "prioritario" && <Badge tone="terracota">Prioritário</Badge>}
                <Badge tone="cinza">{labelCategoria(c.category)}</Badge>
                {c.status !== "resolvido" && !c.first_response_at && (
                  <Badge tone="vermelho">aguardando 1ª resposta</Badge>
                )}
                {!!c.nao_lidas_plataforma && <Badge tone="azul">{c.nao_lidas_plataforma} nova(s)</Badge>}
                <span className="ml-auto text-xs text-stone-400">{dataHoraBR(c.created_at)}</span>
              </div>
              <p className="mt-2 text-sm font-semibold text-tinta-900">{c.subject}</p>
              <p className="mt-1 text-xs text-stone-500">
                {c.company_name ?? "Empresa"} ·{" "}
                {c.plan_slug ? <b className="uppercase">{c.plan_slug}</b> : "sem plano identificado"}
                {c.prioridade_viva === "prioritario" && c.plan_slug !== "empresarial"
                  ? " · prioridade por cortesia/liberação"
                  : ""}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
