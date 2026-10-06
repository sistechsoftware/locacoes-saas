import { requirePlatformAdmin } from "@/lib/auth";
import { listarCobrancasPainel, resumoFinanceiroPainel } from "@/lib/billing";
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

/** Financeiro SaaS: todas as cobranças de todas as empresas. */
export default async function SaasCobrancasPage() {
  // Guard redundante ao layout (ver nota em saas/page.tsx).
  await requirePlatformAdmin();
  const [cobrancas, fin] = await Promise.all([listarCobrancasPainel(300), resumoFinanceiroPainel()]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-black tracking-tight text-tinta-900">Cobranças</h1>
        <p className="text-sm text-stone-500">
          Recebido no mês {money(fin.recebido)} · pendentes {money(fin.pixPendentes)} · inadimplência {money(fin.inadimplencia)}
        </p>
      </div>

      <Card>
        {cobrancas.length === 0 ? (
          <Empty>Nenhuma cobrança gerada ainda.</Empty>
        ) : (
          <div className="divide-y divide-stone-100">
            {cobrancas.map((c) => (
              <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-44">
                  <div className="font-semibold text-tinta-900">{c.empresa}</div>
                  <div className="text-xs text-stone-500">
                    {c.plano ?? "plano removido"} · {money(c.amount_cents)}
                  </div>
                </div>
                <div className="text-xs text-stone-500">
                  período {dataBR(c.period_start)} → {dataBR(c.period_end)}
                </div>
                <div className="text-xs text-stone-500">
                  venc. {dataBR(c.due_date)}
                  {c.paid_at && <> · pago {dataHoraBR(c.paid_at)}</>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={TONE_COBRANCA[c.status] ?? "cinza"}>{ROTULO_COBRANCA[c.status] ?? c.status}</Badge>
                  {c.invoice_url && (
                    <a href={c.invoice_url} target="_blank" rel="noreferrer" className="text-xs font-semibold text-marca-600 underline">
                      fatura
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
