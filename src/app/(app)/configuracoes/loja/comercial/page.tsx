import { requireModule } from "@/lib/auth";
import { temRecurso, bloquearRecurso, registrarNegacao } from "@/lib/plano-gate";
import { lojaDaEmpresa } from "@/lib/loja-db";
import { Alerta, Field, Grid, PageHeader, Section, BTN } from "@/components/ui";
import { salvarRegrasAction } from "../actions";

export const dynamic = "force-dynamic";

const reais = (cents: number) => (Number(cents || 0) / 100).toFixed(2).replace(".", ",");

export default async function ComercialLojaPage({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const ctx = await requireModule("configuracoes");
  if (!(await temRecurso(ctx.user, "loja_virtual"))) {
    registrarNegacao(ctx.companyId, "loja_virtual", "pagina-loja");
    bloquearRecurso("loja_virtual", ctx.user, "pagina");
  }
  const { erro, ok } = await searchParams;
  const l = await lojaDaEmpresa(ctx.companyId);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Configurações comerciais"
        subtitle="Como a loja recebe e conduz cada solicitação. Tudo é validado no backend antes de qualquer aprovação."
      />
      {erro && <Alerta tone="vermelho">{erro}</Alerta>}
      {ok && <Alerta tone="verde">{ok}</Alerta>}

      <form action={salvarRegrasAction} className="space-y-4">
        <Section title="Modo de atendimento">
          <div className="space-y-2 text-sm">
            {[
              { v: "orcamento", t: "Somente orçamento", d: "O cliente monta o pedido e pede uma proposta; você negocia antes de qualquer reserva." },
              { v: "manual", t: "Aprovação manual (padrão)", d: "O cliente envia a solicitação e ela aguarda sua análise para virar reserva." },
              { v: "automatica", t: "Aprovação automática com regras", d: "Solicitações que passarem em tudo (estoque, dados, frete, prazos) são aprovadas na hora; qualquer pendência cai para análise manual." },
            ].map((m) => (
              <label key={m.v} className="flex items-start gap-2 rounded-xl border border-nuvem-200 bg-white px-3 py-2">
                <input type="radio" name="mode" value={m.v} defaultChecked={l?.mode === m.v} className="mt-1" />
                <span>
                  <b>{m.t}</b>
                  <span className="block text-xs text-stone-500">{m.d}</span>
                </span>
              </label>
            ))}
          </div>
        </Section>

        <Section title="Regras de data e pedido">
          <Grid>
            <Field label="Antecedência mínima (dias)" hint="Solicitações com menos que isso são recusadas.">
              <input type="number" name="min_lead_days" min={0} max={365} className="campo" defaultValue={l?.min_lead_days ?? 0} />
            </Field>
            <Field label="Limite de dias futuros (0 = sem limite)">
              <input type="number" name="max_days_ahead" min={0} max={730} className="campo" defaultValue={l?.max_days_ahead ?? 0} />
            </Field>
            <Field label="Valor mínimo do pedido (R$)" hint="0 = sem mínimo.">
              <input name="min_order_cents" className="campo" inputMode="decimal" defaultValue={reais(l?.min_order_cents ?? 0)} />
            </Field>
            <Field label="Percentual de sinal (%)" hint="0 = não exige pagamento antecipado. Exigindo sinal, o Pix é obrigatório.">
              <input type="number" name="signal_percent" min={0} max={100} className="campo" defaultValue={l?.signal_percent ?? 0} />
            </Field>
            <Field label="Prazo de pagamento (horas)" hint="Após esse prazo sem confirmação, a solicitação expira e a reserva é liberada.">
              <input type="number" name="payment_deadline_h" min={1} max={720} className="campo" defaultValue={l?.payment_deadline_h ?? 48} />
            </Field>
          </Grid>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="offer_delivery" defaultChecked={l?.offer_delivery !== 0} /> Aceitar entrega no endereço
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="offer_pickup" defaultChecked={l?.offer_pickup !== 0} /> Aceitar retirada no local
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="hide_prices" defaultChecked={l?.hide_prices === 1} /> Ocultar preços no catálogo
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="freight_pending_ok" defaultChecked={l?.freight_pending_ok !== 0} /> Permitir envio com frete a confirmar
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="require_terms" defaultChecked={l?.require_terms === 1} /> Exigir aceite dos termos
            </label>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Cálculo de frete" hint="Mesma fórmula e endereço-base do módulo de Fretes.">
              <select name="freight_type" className="campo" defaultValue={l?.freight_type ?? "locacao"}>
                <option value="locacao">Locação (ida e volta do evento)</option>
                <option value="comum">Frete comum (ida e volta)</option>
              </select>
            </Field>
          </div>
        </Section>

        <Section title="Textos comerciais">
          <div className="grid gap-3">
            <Field label="Termos de locação exibidos na loja">
              <textarea name="terms_text" className="campo" rows={4} maxLength={8000} defaultValue={l?.terms_text ?? ""} />
            </Field>
            <Field label="Política de cancelamento">
              <textarea name="cancellation_text" className="campo" rows={3} maxLength={4000} defaultValue={l?.cancellation_text ?? ""} />
            </Field>
            <Field label="Aviso de privacidade (LGPD)">
              <textarea name="privacy_text" className="campo" rows={3} maxLength={4000} defaultValue={l?.privacy_text ?? ""} />
            </Field>
            <Field label="Mensagem exibida após o envio" hint="Vazio = mensagem padrão da loja.">
              <textarea name="success_message" className="campo" rows={2} maxLength={1000} defaultValue={l?.success_message ?? ""} />
            </Field>
          </div>
        </Section>

        <div className="flex justify-end">
          <button type="submit" className={BTN.primario}>
            Salvar regras
          </button>
        </div>
      </form>
    </div>
  );
}
