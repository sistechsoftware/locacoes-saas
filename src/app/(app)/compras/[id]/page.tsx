import Link from "next/link";
import { notFound } from "next/navigation";
import { all } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { getPurchase, purchaseEntries, purchaseItems, purchaseStockMovements } from "@/lib/compras";
import { activeAccounts } from "@/lib/compras";
import { situacaoParcela } from "@/lib/financeiro";
import { logsFor } from "@/lib/audit";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL } from "@/lib/domain";
import { dateBR, money, today, utcParaLocal } from "@/lib/format";
import { Alerta, Badge, Card, Empty, LinkButton, PageHeader, Row, Section, Stat } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { cancelPurchase, payEntry, reverseExpense } from "../actions";

export const dynamic = "force-dynamic";

const TOM: Record<string, "verde" | "ambar" | "vermelho" | "cinza"> = {
  quitada: "verde",
  parcial: "ambar",
  vencida: "vermelho",
  aberta: "cinza",
  cancelada: "cinza",
};

export default async function CompraPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ aviso?: string }>;
}) {
  const user = await requireUser();
  const { id } = await params;
  const { aviso } = await searchParams;
  const compra = await getPurchase(Number(id));
  if (!compra) notFound();

  const [itens, parcelas, movimentos, pagamentos, contas, historico] = await Promise.all([
    purchaseItems(compra.id),
    purchaseEntries(compra.id),
    purchaseStockMovements(compra.id),
    all<any>(
      `SELECT * FROM expenses WHERE purchase_id = ? ORDER BY date DESC, id DESC`,
      [compra.id],
    ),
    activeAccounts(),
    logsFor("compra", compra.id),
  ]);

  const d0 = today();
  const totalPago = pagamentos.reduce((s: number, p: any) => s + p.amount_cents, 0);
  // compra cancelada nao deve mais nada: o estoque voltou e as parcelas foram canceladas
  const saldo = compra.status === "cancelada" ? 0 : compra.total_cents - totalPago;
  // editar o valor de uma compra ja paga nao refaz o parcelamento, para nao
  // apagar pagamento registrado; quando isso deixa uma diferenca a descoberto,
  // ela precisa aparecer em vez de sumir na conta
  const totalParcelas = parcelas
    .filter((p: any) => p.status !== "cancelada")
    .reduce((s: number, p: any) => s + p.amount_cents, 0);
  const descoberto = compra.status === "cancelada" ? 0 : compra.total_cents - totalParcelas;

  return (
    <div className="space-y-4">
      <PageHeader
        title={compra.number}
        subtitle={`${compra.supplier_name ?? "Sem fornecedor"} · ${dateBR(compra.purchase_date)}`}
        action={
          compra.status !== "cancelada" ? (
            <LinkButton href={`/compras/${compra.id}/editar`}>Editar</LinkButton>
          ) : undefined
        }
      />

      {aviso && <Alerta tone="ambar" title="Atenção">{aviso}</Alerta>}
      {descoberto !== 0 && parcelas.length > 0 && (
        <Alerta tone="ambar" title="As parcelas não cobrem o total da compra">
          A compra soma {money(compra.total_cents)} e as parcelas somam {money(totalParcelas)}, uma diferença de{" "}
          {money(Math.abs(descoberto))} {descoberto > 0 ? "a mais na compra" : "a mais nas parcelas"}. Isso acontece
          quando o valor muda depois de uma parcela já paga, porque refazer o parcelamento apagaria o pagamento.
          Ajuste as parcelas manualmente ou estorne o pagamento e salve de novo.
        </Alerta>
      )}
      {compra.status === "cancelada" && (
        <Alerta tone="vermelho" title="Compra cancelada">
          O estoque foi estornado e as parcelas em aberto foram canceladas. O histórico fica preservado.
        </Alerta>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-2">
          {compra.affects_stock ? (
            <Badge tone="azul">Entrou no estoque</Badge>
          ) : (
            <Badge tone="cinza">Histórica · não mexeu no estoque</Badge>
          )}
          <Badge tone={compra.kind === "investimento" ? "terracota" : "cinza"}>
            {compra.kind === "investimento" ? "Investimento" : "Despesa operacional"}
          </Badge>
          {compra.status !== "cancelada" &&
            (saldo > 0 ? <Badge tone="ambar">A pagar {money(saldo)}</Badge> : <Badge tone="verde">Quitada</Badge>)}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Stat label="Total da compra" value={money(compra.total_cents)} />
        <Stat label="Pago" value={money(totalPago)} tone="verde" />
        <Stat label="A pagar" value={money(Math.max(0, saldo))} tone={saldo > 0 ? "vermelho" : "verde"} />
        <Stat label="Itens" value={compra.item_qty} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title={`Itens (${itens.length})`}>
          {itens.length === 0 ? (
            <Empty>Nenhum item.</Empty>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {itens.map((i: any) => (
                <li key={i.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <Link href={`/estoque/${i.product_id}`} className="block truncate text-sm font-semibold text-marca-600">
                      {i.qty} x {i.product_name}
                    </Link>
                    <span className="block text-xs text-stone-500">
                      {money(i.unit_price_cents)} cada
                      {i.discount_cents > 0 ? ` · desconto ${money(i.discount_cents)}` : ""}
                      {i.stock_applied_qty > 0 ? ` · ${i.stock_applied_qty} no estoque` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 text-sm font-bold">{money(i.subtotal_cents)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 space-y-1 rounded-xl bg-nuvem-100 p-3 text-sm">
            <Row label="Itens" value={money(compra.items_cents)} />
            <Row label="Desconto" value={"- " + money(compra.discount_cents)} />
            <div className="flex items-center justify-between pt-1 text-base font-bold">
              <span>Total</span>
              <span>{money(compra.total_cents)}</span>
            </div>
          </div>
        </Section>

        <Section title={`Parcelas (${parcelas.length})`}>
          {parcelas.length === 0 ? (
            <Empty>Sem parcelas registradas.</Empty>
          ) : (
            <ul className="space-y-2">
              {parcelas.map((p: any) => {
                const sit = situacaoParcela(p, p.pago_cents, d0);
                const falta = Math.max(0, p.amount_cents - p.pago_cents);
                return (
                  <li key={p.id} className="rounded-xl border border-nuvem-300 bg-white p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span>
                        <span className="text-sm font-bold text-tinta-900">
                          {p.installment}/{p.installments_total} · {money(p.amount_cents)}
                        </span>
                        <span className="ml-2 text-xs text-stone-500">vence em {dateBR(p.due_date)}</span>
                      </span>
                      <Badge tone={TOM[sit]}>{sit}</Badge>
                    </div>
                    {p.pago_cents > 0 && sit !== "quitada" && (
                      <p className="mt-1 text-xs text-stone-500">
                        Pago {money(p.pago_cents)}, faltam {money(falta)}
                      </p>
                    )}
                    {sit !== "quitada" && sit !== "cancelada" && compra.status !== "cancelada" && (
                      <form action={payEntry} className="mt-2 grid grid-cols-2 gap-2">
                        <input type="hidden" name="entry_id" value={p.id} />
                        <input
                          name="amount"
                          defaultValue={(falta / 100).toFixed(2)}
                          inputMode="decimal"
                          className="campo"
                          aria-label="Valor"
                        />
                        <input name="paid_at" type="date" defaultValue={d0} className="campo" />
                        <select name="method" className="campo">
                          {PAYMENT_METHODS.map((m) => (
                            <option key={m} value={m}>
                              {PAYMENT_METHOD_LABEL[m]}
                            </option>
                          ))}
                        </select>
                        <select name="account_id" defaultValue={p.account_id ?? ""} className="campo">
                          <option value="">Conta…</option>
                          {contas.map((c: any) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                        <div className="col-span-2">
                          <SubmitButton className="w-full">Registrar pagamento</SubmitButton>
                        </div>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-xs text-stone-500">
            O caixa registra apenas o que foi efetivamente pago, nunca o total da compra de uma vez.
          </p>
        </Section>
      </div>

      {pagamentos.length > 0 && (
        <Section title="Pagamentos realizados">
          <ul className="divide-y divide-nuvem-200">
            {pagamentos.map((p: any) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0">
                  <span className="block font-semibold">
                    {p.amount_cents < 0 ? "Estorno " : ""}
                    {money(Math.abs(p.amount_cents))}
                  </span>
                  <span className="block text-xs text-stone-500">
                    {dateBR(p.date)} · {PAYMENT_METHOD_LABEL[p.method] ?? p.method}
                  </span>
                </span>
                {user.role === "admin" && p.amount_cents > 0 && (
                  <form action={reverseExpense}>
                    <input type="hidden" name="expense_id" value={p.id} />
                    <SubmitButton
                      variant="perigo"
                      confirm="Estornar este pagamento? O estorno fica registrado no histórico."
                      className="px-2.5 py-1.5 text-xs"
                    >
                      Estornar
                    </SubmitButton>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {movimentos.length > 0 && (
        <Section title="Movimentação de Estoque">
          <ul className="divide-y divide-nuvem-200">
            {movimentos.map((m: any) => (
              <li key={m.id} className="flex items-center justify-between py-2 text-sm">
                <span>
                  <span className="font-semibold">{m.product_name}</span>
                  <span className="ml-2 text-xs text-stone-500">{utcParaLocal(m.created_at)}</span>
                </span>
                <span className={m.qty_delta > 0 ? "font-bold text-emerald-600" : "font-bold text-red-600"}>
                  {m.qty_delta > 0 ? "+" : ""}
                  {m.qty_delta}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

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

      {user.role === "admin" && compra.status !== "cancelada" && (
        <Card className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-tinta-900">Área do administrador</p>
            <p className="text-xs text-stone-500">
              Cancelar estorna o estoque que esta compra somou e mantém todo o histórico.
            </p>
          </div>
          <form action={cancelPurchase}>
            <input type="hidden" name="id" value={compra.id} />
            <SubmitButton variant="perigo" confirm={`Cancelar a compra ${compra.number} e estornar o estoque?`}>
              Cancelar Compra
            </SubmitButton>
          </form>
        </Card>
      )}
    </div>
  );
}
