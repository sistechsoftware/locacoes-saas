"use client";
import { useState } from "react";
import { Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { money, parseMoney } from "@/lib/format";
import { montarParcelas } from "@/lib/financeiro";

type Action = (fd: FormData) => void | Promise<void>;

/**
 * Formulario do lancamento manual de conta a pagar.
 *
 * Segue o padrao visual do formulario de compras: Grid/Field do design system,
 * previa das parcelas calculada pela MESMA funcao pura que a compra usa
 * (montarParcelas), e botao que trava o envio enquanto grava (SubmitButton),
 * contra duplo clique. Erros voltam pelo redirect padrao da pagina (sp.erro),
 * como no formulario de saidas. O lancamento nasce pendente sempre; aqui nao
 * existe campo de status nem de valor pago.
 */
export default function NovoPagarForm({
  action,
  finalidades,
  fornecedores,
  contas,
  hoje,
}: {
  action: Action;
  finalidades: string[];
  fornecedores: { id: number; name: string }[];
  contas: { id: number; name: string }[];
  hoje: string;
}) {
  const [valor, setValor] = useState("");
  const [parcelas, setParcelas] = useState("1");
  const [vencimento, setVencimento] = useState("");
  const [dataCompra, setDataCompra] = useState(hoje);

  const nParcelas = Math.max(1, Number(parcelas) || 1);
  const total = parseMoney(valor);
  // mesma regra de parcelamento das compras: sobra de centavos na primeira
  // parcela, vencimentos mensais preservando o dia
  const previa = total > 0 && vencimento ? montarParcelas(total, nParcelas, vencimento) : [];

  return (
    <form action={action} className="space-y-3">
      <Grid>
        <Field label="Descrição *" className="col-span-full sm:col-span-2">
          <input
            name="descricao"
            placeholder="Ex.: Compra de produto no cartão"
            maxLength={200}
            required
            className="campo"
          />
        </Field>
        <Field label="Valor (R$) *" hint="Ex.: 500,00 ou 1.234,56">
          <input
            name="amount"
            value={valor}
            onChange={(e) => setValor(e.target.value)}
            inputMode="decimal"
            required
            className="campo"
          />
        </Field>
        <Field label="Parcelas">
          <input
            name="parcelas"
            type="number"
            min={1}
            max={60}
            value={parcelas}
            onChange={(e) => setParcelas(e.target.value)}
            className="campo"
          />
        </Field>
        <Field label="Data da compra (competência) *" hint="Quando a despesa aconteceu, ex.: dia da compra no cartão.">
          <input
            name="purchase_date"
            type="date"
            value={dataCompra}
            onChange={(e) => setDataCompra(e.target.value)}
            required
            className="campo"
          />
        </Field>
        <Field label="Vencimento *" hint="Quando o dinheiro deve sair, ex.: fechamento da fatura.">
          <input
            name="due_date"
            type="date"
            value={vencimento}
            onChange={(e) => setVencimento(e.target.value)}
            required
            className="campo"
          />
        </Field>
        <Field label="Finalidade / categoria">
          <select name="category" defaultValue={finalidades[0]} className="campo">
            {finalidades.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Fornecedor">
          <select name="supplier_id" defaultValue="" className="campo">
            <option value="">Sem fornecedor</option>
            {fornecedores.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Conta prevista" hint="Apenas uma sugestão; o dinheiro só sai na baixa do pagamento.">
          <select name="account_id" defaultValue="" className="campo">
            <option value="">Não definida</option>
            {contas.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Observação">
          <input name="notes" maxLength={500} className="campo" />
        </Field>
      </Grid>

      {previa.length > 0 && (
        <div className="rounded-xl bg-nuvem-100 p-3">
          <p className="mb-1.5 text-xs font-semibold uppercase text-stone-500">
            {previa.length === 1 ? "Pagamento único" : `${previa.length} parcelas`}
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
            {previa.slice(0, 6).map((p) => (
              <span key={p.installment}>
                {p.installment}/{p.installments_total} {money(p.amount_cents)} em {p.due_date.split("-").reverse().join("/")}
              </span>
            ))}
            {previa.length > 6 && <span>e mais {previa.length - 6}...</span>}
          </div>
          <p className="mt-2 text-xs text-stone-500">
            Todas as parcelas nascem pendentes. O caixa só registra cada uma quando você efetuar o pagamento.
          </p>
        </div>
      )}

      <SubmitButton className="w-full sm:w-auto">Lançar Conta</SubmitButton>
    </form>
  );
}
