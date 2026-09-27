"use client";
import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { Alerta, Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { Icon } from "@/components/Icons";
import { money, parseMoney } from "@/lib/format";
import { montarParcelas, subtotaisCompra } from "@/lib/financeiro";

type Produto = { id: number; code: string; name: string; category: string | null; kind?: string };
type Item = { product_id: number; qty: number; unit_price_cents: number; discount_cents: number };
type Action = (prev: string | null, fd: FormData) => Promise<string | null>;

export default function PurchaseForm({
  action,
  produtos,
  fornecedores,
  contas,
  compra,
  items: itensIniciais = [],
  parcelasIniciais = 1,
  submitLabel = "Salvar Compra",
}: {
  action: Action;
  produtos: Produto[];
  fornecedores: { id: number; name: string }[];
  contas: { id: number; name: string }[];
  compra?: any;
  items?: Item[];
  parcelasIniciais?: number;
  submitLabel?: string;
}) {
  const [error, formAction] = useActionState(action, null);
  const [itens, setItens] = useState<Item[]>(itensIniciais);
  const [desconto, setDesconto] = useState(cents(compra?.discount_cents));
  const [afetaEstoque, setAfetaEstoque] = useState<boolean>(compra ? !!compra.affects_stock : true);
  const [parcelas, setParcelas] = useState(String(parcelasIniciais));
  const [dataCompra, setDataCompra] = useState(compra?.purchase_date ?? "");
  const [vencimento, setVencimento] = useState("");

  const byId = useMemo(() => new Map(produtos.map((p) => [p.id, p])), [produtos]);
  const { itensTotal, total } = subtotaisCompra(itens, parseMoney(desconto));

  const add = (productId: number) =>
    setItens((atuais) =>
      !productId || atuais.some((i) => i.product_id === productId)
        ? atuais
        : [...atuais, { product_id: productId, qty: 1, unit_price_cents: 0, discount_cents: 0 }],
    );
  const patch = (idx: number, mud: Partial<Item>) =>
    setItens((atuais) => atuais.map((i, k) => (k === idx ? { ...i, ...mud } : i)));
  const remove = (idx: number) => setItens((atuais) => atuais.filter((_, k) => k !== idx));

  const nParcelas = Math.max(1, Number(parcelas) || 1);
  const previa =
    total > 0 && vencimento ? montarParcelas(total, nParcelas, vencimento) : [];

  const grupos = useMemo(() => {
    const g = new Map<string, Produto[]>();
    for (const p of produtos) {
      const k = p.category ?? "Sem categoria";
      g.set(k, [...(g.get(k) ?? []), p]);
    }
    return [...g.entries()];
  }, [produtos]);

  return (
    <form action={formAction} className="space-y-4">
      {compra && <input type="hidden" name="id" value={compra.id} />}
      <input type="hidden" name="items" value={JSON.stringify(itens)} />
      <input type="hidden" name="discount" value={desconto} />
      <input type="hidden" name="affects_stock" value={afetaEstoque ? "1" : "0"} />

      <section className="cartao p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Compra</h2>
        <Grid>
          <Field label="Fornecedor">
            <div className="flex gap-2">
              <select name="supplier_id" defaultValue={compra?.supplier_id ?? ""} className="campo flex-1">
                <option value="">Sem fornecedor</option>
                {fornecedores.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
              <Link
                href="/configuracoes?aba=fornecedores"
                className="flex items-center rounded-xl border border-nuvem-300 bg-white px-3 text-sm font-semibold"
              >
                Novo
              </Link>
            </div>
          </Field>
          <Field label="Data da compra *">
            <input
              name="purchase_date"
              type="date"
              value={dataCompra}
              onChange={(e) => {
                setDataCompra(e.target.value);
                if (!vencimento) setVencimento(e.target.value);
              }}
              className="campo"
              required
            />
          </Field>
          <Field label="Tipo de gasto" hint="Separa o que virou patrimônio do que é custo de operar.">
            <select name="kind" defaultValue={compra?.kind ?? "investimento"} className="campo">
              <option value="investimento">Investimento (mesas, cadeiras, equipamentos)</option>
              <option value="operacional">Despesa operacional (material, consumo)</option>
            </select>
          </Field>
          <Field label="Observações">
            <input name="notes" defaultValue={compra?.notes ?? ""} className="campo" />
          </Field>
        </Grid>

        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <ModoEstoque
            checked={afetaEstoque}
            onSelect={() => setAfetaEstoque(true)}
            titulo="Compra atual"
            descricao="Os produtos entram no estoque agora."
          />
          <ModoEstoque
            checked={!afetaEstoque}
            onSelect={() => setAfetaEstoque(false)}
            titulo="Compra Histórica"
            descricao="Registra o gasto antigo sem mexer no estoque de hoje."
          />
        </div>
      </section>

      <section className="cartao p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Itens</h2>
        <select value="" onChange={(e) => add(Number(e.target.value))} className="campo">
          <option value="">+ Adicionar produto…</option>
          {grupos.map(([cat, lista]) => (
            <optgroup key={cat} label={cat}>
              {lista.map((p) => (
                <option key={p.id} value={p.id} disabled={itens.some((i) => i.product_id === p.id)}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        {itens.length === 0 ? (
          <p className="mt-3 rounded-xl border border-dashed border-nuvem-300 bg-nuvem-50 px-3 py-6 text-center text-sm text-stone-500">
            Nenhum item. Use os produtos já cadastrados no estoque.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {itens.map((item, idx) => {
              const p = byId.get(item.product_id);
              const sub = Math.max(0, item.qty * item.unit_price_cents - item.discount_cents);
              return (
                <div key={item.product_id} className="rounded-xl border border-nuvem-300 bg-white p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-tinta-900">{p?.name ?? "Produto"}</p>
                      <p className="text-xs text-stone-500">{p?.code}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => remove(idx)}
                      className="rounded-lg p-1.5 text-red-600 hover:bg-red-50"
                      aria-label="Remover item"
                    >
                      <Icon name="fechar" className="h-4 w-4" />
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <label className="block">
                      <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase text-stone-500">Qtd</span>
                      <input
                        type="number"
                        min={1}
                        value={item.qty}
                        onChange={(e) => patch(idx, { qty: Math.max(1, Number(e.target.value) || 1) })}
                        className="w-full rounded-lg border border-nuvem-300 px-2 py-2 text-sm outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase text-stone-500">
                        Valor un.
                      </span>
                      <input
                        defaultValue={(item.unit_price_cents / 100).toFixed(2)}
                        onBlur={(e) => patch(idx, { unit_price_cents: parseMoney(e.target.value) })}
                        inputMode="decimal"
                        className="w-full rounded-lg border border-nuvem-300 px-2 py-2 text-sm outline-none"
                      />
                    </label>
                    <label className="block">
                      <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase text-stone-500">
                        Desconto
                      </span>
                      <input
                        defaultValue={(item.discount_cents / 100).toFixed(2)}
                        onBlur={(e) => patch(idx, { discount_cents: parseMoney(e.target.value) })}
                        inputMode="decimal"
                        className="w-full rounded-lg border border-nuvem-300 px-2 py-2 text-sm outline-none"
                      />
                    </label>
                  </div>
                  <p className="mt-2 text-right text-sm font-bold text-tinta-900">{money(sub)}</p>
                </div>
              );
            })}
          </div>
        )}

        <div className="mt-3 space-y-1 rounded-xl bg-nuvem-100 p-3 text-sm">
          <div className="flex justify-between text-stone-600">
            <span>Itens</span>
            <span className="font-medium text-tinta-900">{money(itensTotal)}</span>
          </div>
          <label className="flex items-center justify-between gap-2 text-stone-600">
            <span>Desconto geral</span>
            <input
              value={desconto}
              onChange={(e) => setDesconto(e.target.value)}
              inputMode="decimal"
              className="w-28 rounded-lg border border-nuvem-300 px-2 py-1 text-right text-sm outline-none"
            />
          </label>
          <div className="flex items-center justify-between border-t border-nuvem-300 pt-2 text-base font-bold">
            <span>Total da Compra</span>
            <span>{money(total)}</span>
          </div>
        </div>
      </section>

      <section className="cartao p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Pagamento</h2>
        <Grid cols={3}>
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
          <Field label="1º vencimento">
            <input
              name="primeiro_vencimento"
              type="date"
              value={vencimento}
              onChange={(e) => setVencimento(e.target.value)}
              className="campo"
            />
          </Field>
          <Field label="Conta prevista">
            <select name="account_id" defaultValue="" className="campo">
              <option value="">Não definida</option>
              {contas.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
        </Grid>

        {previa.length > 0 && (
          <div className="mt-3 rounded-xl bg-nuvem-100 p-3">
            <p className="mb-1.5 text-xs font-semibold uppercase text-stone-500">
              {previa.length === 1 ? "Pagamento à vista" : `${previa.length} parcelas`}
            </p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
              {previa.slice(0, 6).map((p) => (
                <span key={p.installment}>
                  {p.installment}/{p.installments_total} {money(p.amount_cents)} em{" "}
                  {p.due_date.split("-").reverse().join("/")}
                </span>
              ))}
              {previa.length > 6 && <span>e mais {previa.length - 6}...</span>}
            </div>
            <p className="mt-2 text-xs text-stone-500">
              O caixa só registra cada parcela quando ela for efetivamente paga.
            </p>
          </div>
        )}
      </section>

      {afetaEstoque && itens.length > 0 && (
        <Alerta tone="azul" title="Esta compra vai somar ao estoque">
          {itens.map((i) => `${i.qty} ${byId.get(i.product_id)?.name ?? ""}`).join(", ")}
        </Alerta>
      )}

      {error && <Alerta tone="vermelho">{error}</Alerta>}

      <div className="sticky bottom-20 z-10 md:bottom-4">
        <SubmitButton className="w-full py-3 text-base shadow-lg">{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}

function ModoEstoque({
  checked,
  onSelect,
  titulo,
  descricao,
}: {
  checked: boolean;
  onSelect: () => void;
  titulo: string;
  descricao: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`rounded-xl border p-3 text-left transition ${
        checked ? "border-marca-600 bg-marca-50" : "border-nuvem-300 bg-white hover:bg-nuvem-50"
      }`}
    >
      <span className="flex items-center gap-2">
        <span
          className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
            checked ? "border-marca-600" : "border-stone-300"
          }`}
        >
          {checked && <span className="h-2 w-2 rounded-full bg-marca-600" />}
        </span>
        <span className="text-sm font-bold text-tinta-900">{titulo}</span>
      </span>
      <span className="mt-1 block text-xs leading-snug text-stone-500">{descricao}</span>
    </button>
  );
}

const cents = (v: number | undefined) => ((v ?? 0) / 100).toFixed(2);
