import Link from "next/link";
import {
  listarEmpresasPainel,
  metricasPainel,
  resumoFinanceiroPainel,
  listarCobrancasPainel,
  alertasSaasPainel,
  atividadeRecentePainel,
  STATUS_ROTULO,
  type SubscriptionStatus,
} from "@/lib/billing";
import { asaasEnvironment } from "@/lib/asaas";
import { Card, Badge, Empty } from "@/components/ui";

export const dynamic = "force-dynamic";

function money(centavos: number | null) {
  if (centavos === null) return "—";
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function dataBR(iso: string | null) {
  return iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—";
}

function dataHoraBR(sql: string | null) {
  if (!sql) return "—";
  const [dia, hora] = sql.slice(0, 16).split(" ");
  return `${dia.split("-").reverse().join("/")}${hora ? ` ${hora}` : ""}`;
}

const TONE: Record<SubscriptionStatus | "sem", any> = {
  trial: "ambar",
  active: "verde",
  past_due: "terracota",
  suspended: "vermelho",
  canceled: "cinza",
  sem: "cinza",
};

const TONE_COBRANCA: Record<string, any> = {
  received: "verde",
  confirmed: "verde",
  pending: "ambar",
  overdue: "vermelho",
  refunded: "terracota",
  canceled: "cinza",
};

const ROTULO_COBRANCA: Record<string, string> = {
  received: "paga",
  confirmed: "paga",
  pending: "pendente",
  overdue: "vencida",
  refunded: "estornada",
  canceled: "cancelada",
};

/**
 * Dashboard da PLATAFORMA: responde "como está meu SaaS?" — empresas,
 * assinaturas, receita, inadimplência, alertas e atividade administrativa.
 * Nada de operação de locadora aqui (isso vive no ambiente do cliente).
 */
export default async function SaasDashboard() {
  const [empresas, m, fin, env, cobrancas, alertas, atividade] = await Promise.all([
    listarEmpresasPainel(),
    metricasPainel(),
    resumoFinanceiroPainel(),
    asaasEnvironment(),
    listarCobrancasPainel(6),
    alertasSaasPainel(),
    atividadeRecentePainel(8),
  ]);

  const novasEmpresas = empresas.filter((e) => !e.status).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-black tracking-tight text-tinta-900">Visão geral da plataforma</h1>
          <p className="text-sm text-stone-500">Como está o SaaS hoje · Asaas: {env === "nao_configurado" ? "não configurado" : env}</p>
        </div>
      </div>

      {/* Alertas prioritários */}
      {alertas.length > 0 && (
        <div className="space-y-2">
          {alertas.slice(0, 5).map((a, i) => (
            <Link
              key={i}
              href={a.href}
              className={`flex items-start gap-3 rounded-xl border px-4 py-3 transition hover:shadow-sm ${
                a.severidade === "critico"
                  ? "border-red-200 bg-red-50"
                  : a.severidade === "aviso"
                    ? "border-amber-200 bg-amber-50"
                    : "border-sky-200 bg-sky-50"
              }`}
            >
              <span className="mt-0.5 text-lg">
                {a.severidade === "critico" ? "🚨" : a.severidade === "aviso" ? "⏳" : "ℹ️"}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-bold text-tinta-900">{a.titulo}</span>
                <span className="block text-xs text-stone-600">{a.detalhe}</span>
              </span>
            </Link>
          ))}
        </div>
      )}

      {/* Métricas da plataforma */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ["MRR", money(m.mrr)],
          ["Ativas", String(m.ativas)],
          ["Em trial", String(m.trials)],
          ["Suspensas", String(m.suspensas)],
          ["Empresas", String(m.empresas)],
        ].map(([rotulo, valor]) => (
          <Card key={rotulo} className="text-center">
            <div className="text-xs font-bold uppercase tracking-wide text-stone-500">{rotulo}</div>
            <div className="mt-1 text-xl font-black text-tinta-900">{valor}</div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          ["Recebido no mês", money(fin.recebido)],
          ["PIX pendentes", `${money(fin.pixPendentes)} (${fin.pixPendentesQtd})`],
          ["Inadimplentes", `${money(fin.inadimplencia)} (${fin.inadimplentesQtd} emp.)`],
        ].map(([rotulo, valor]) => (
          <Card key={rotulo} className="text-center">
            <div className="text-xs font-bold uppercase tracking-wide text-stone-500">{rotulo}</div>
            <div className="mt-1 text-xl font-black text-tinta-900">{valor}</div>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Pagamentos recentes</h2>
            <Link href="/saas/cobrancas" className="text-xs font-semibold text-emerald-700 hover:underline">
              ver todas
            </Link>
          </div>
          {cobrancas.length === 0 ? (
            <Empty>Nenhuma cobrança gerada ainda.</Empty>
          ) : (
            <div className="divide-y divide-stone-100">
              {cobrancas.map((c) => (
                <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div className="min-w-40">
                    <div className="text-sm font-semibold text-tinta-900">{c.empresa}</div>
                    <div className="text-xs text-stone-500">
                      {money(c.amount_cents)} · venc. {dataBR(c.due_date)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={TONE_COBRANCA[c.status] ?? "cinza"}>{ROTULO_COBRANCA[c.status] ?? c.status}</Badge>
                    {c.paid_at && <span className="text-xs text-stone-500">{dataHoraBR(c.paid_at)}</span>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Atividade administrativa</h2>
            <Link href="/saas/atividade" className="text-xs font-semibold text-emerald-700 hover:underline">
              ver tudo
            </Link>
          </div>
          {atividade.length === 0 ? (
            <Empty>Sem registros ainda.</Empty>
          ) : (
            <div className="divide-y divide-stone-100">
              {atividade.map((a) => (
                <div key={a.id} className="py-2">
                  <div className="text-sm text-tinta-900">{a.summary}</div>
                  <div className="text-xs text-stone-500">
                    {a.user_name ?? "sistema"} · {dataHoraBR(a.created_at)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Empresas</h2>
          <Link href="/saas/empresas" className="text-xs font-semibold text-emerald-700 hover:underline">
            gerenciar
          </Link>
        </div>
        <div className="divide-y divide-stone-100">
          {empresas.slice(0, 5).map((e) => (
            <div key={e.company_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-40">
                <div className="text-sm font-semibold text-tinta-900">{e.name}</div>
                <div className="text-xs text-stone-500">
                  {e.plano ? `${e.plano} · ${money(e.price_cents)}/mês` : "sem assinatura"}
                </div>
              </div>
              <Badge tone={TONE[e.status ?? "sem"]}>{e.status ? STATUS_ROTULO[e.status] : "novo"}</Badge>
            </div>
          ))}
        </div>
        {novasEmpresas > 0 && (
          <p className="mt-3 text-xs text-stone-500">
            {novasEmpresas} empresa{novasEmpresas === 1 ? "" : "s"} aguardando primeiro acesso (o trial nasce no login).
          </p>
        )}
      </Card>
    </div>
  );
}
