"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { Alerta, Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { Icon } from "@/components/Icons";
import { money, parseMoney } from "@/lib/format";
import { rotuloFaixa, validarFaixas, type Faixa } from "@/lib/promocoes";

type Produto = { id: number; name: string; code: string; rent_price_cents: number; kind?: string };
type Action = (prev: string | null, fd: FormData) => Promise<string | null>;

/** Faixa em edicao: os numeros ficam como texto para o campo aceitar vazio. */
type Linha = { min: string; max: string; preco: string };

const paraFaixa = (l: Linha): Faixa => ({
  min_qty: Math.trunc(Number(l.min) || 0),
  max_qty: l.max.trim() === "" ? null : Math.trunc(Number(l.max) || 0),
  unit_price_cents: parseMoney(l.preco),
});

export default function PromotionForm({
  action,
  produtos,
  promocao,
  submitLabel = "Salvar Promoção",
}: {
  action: Action;
  produtos: Produto[];
  promocao?: any;
  submitLabel?: string;
}) {
  const [erro, formAction] = useActionState(action, null);
  const [productId, setProductId] = useState(String(promocao?.product_id ?? ""));
  const [ativa, setAtiva] = useState<boolean>(promocao ? !!promocao.active : true);
  const [linhas, setLinhas] = useState<Linha[]>(
    promocao?.tiers?.length
      ? promocao.tiers.map((t: Faixa) => ({
          min: String(t.min_qty),
          max: t.max_qty === null ? "" : String(t.max_qty),
          preco: (t.unit_price_cents / 100).toFixed(2),
        }))
      : [{ min: "1", max: "", preco: "" }],
  );

  const produto = produtos.find((p) => String(p.id) === productId);
  const faixas = linhas.map(paraFaixa);
  const problemas = validarFaixas(faixas);
  const erros = problemas.filter((p) => p.tipo === "erro");
  const avisos = problemas.filter((p) => p.tipo === "aviso");

  const patch = (i: number, mud: Partial<Linha>) =>
    setLinhas((atuais) => atuais.map((l, k) => (k === i ? { ...l, ...mud } : l)));
  const remover = (i: number) => setLinhas((atuais) => atuais.filter((_, k) => k !== i));
  const adicionar = () =>
    setLinhas((atuais) => {
      const ultima = atuais[atuais.length - 1];
      const proximoMin = ultima && ultima.max.trim() !== "" ? String(Number(ultima.max) + 1) : "";
      return [...atuais, { min: proximoMin, max: "", preco: "" }];
    });

  return (
    <form action={formAction} className="space-y-4">
      {promocao && <input type="hidden" name="id" value={promocao.id} />}
      <input type="hidden" name="tiers" value={JSON.stringify(faixas)} />
      <input type="hidden" name="active" value={ativa ? "1" : "0"} />

      {erro && <Alerta tone="vermelho" title="Não foi possível salvar">{erro}</Alerta>}

      <section className="cartao p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Promoção</h2>
        <Grid>
          <Field label="Produto *">
            <select
              name="product_id"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className="campo"
              required
            >
              <option value="">Selecione…</option>
              {produtos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.kind === "kit" ? "[KIT] " : ""}
                  {p.name} · normal {money(p.rent_price_cents)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nome da promoção" hint="Opcional, só para você identificar na lista.">
            <input name="name" defaultValue={promocao?.name ?? ""} maxLength={120} className="campo" />
          </Field>
          <Field label="Início" hint="Deixe vazio para valer desde já.">
            <input type="date" name="starts_on" defaultValue={promocao?.starts_on ?? ""} className="campo" />
          </Field>
          <Field label="Fim" hint="Deixe vazio para não expirar.">
            <input type="date" name="ends_on" defaultValue={promocao?.ends_on ?? ""} className="campo" />
          </Field>
          <Field label="Observações" className="sm:col-span-2">
            <input name="notes" defaultValue={promocao?.notes ?? ""} maxLength={500} className="campo" />
          </Field>
        </Grid>

        <label className="mt-3 flex items-center gap-2 text-sm font-semibold text-tinta-900">
          <input type="checkbox" checked={ativa} onChange={(e) => setAtiva(e.target.checked)} className="h-4 w-4" />
          Promoção ativa
        </label>
        {!ativa && <p className="mt-1 text-xs text-stone-500">Desativada, o sistema usa o preço normal do produto.</p>}
      </section>

      <section className="cartao p-4">
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-stone-500">Faixas de Preço</h2>
        <p className="mb-3 text-xs text-stone-500">
          O preço da faixa vale para <b>todas</b> as unidades, não só para as que passarem do limite. Deixe a coluna
          &quot;Até&quot; vazia para uma faixa sem limite.
        </p>

        <div className="space-y-2">
          {linhas.map((l, i) => (
            <div key={i} className="rounded-xl border border-nuvem-300 bg-white p-3">
              <div className="grid grid-cols-3 gap-2">
                <label className="block">
                  <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase text-stone-500">De</span>
                  <input
                    type="number"
                    min={1}
                    value={l.min}
                    onChange={(e) => patch(i, { min: e.target.value })}
                    className="w-full rounded-lg border border-nuvem-300 px-2 py-2 text-sm outline-none"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase text-stone-500">Até</span>
                  <input
                    type="number"
                    min={1}
                    value={l.max}
                    placeholder="sem limite"
                    onChange={(e) => patch(i, { max: e.target.value })}
                    className="w-full rounded-lg border border-nuvem-300 px-2 py-2 text-sm outline-none"
                  />
                </label>
                <label className="block">
                  <span className="mb-0.5 block text-[0.68rem] font-semibold uppercase text-stone-500">
                    Preço por unidade
                  </span>
                  <input
                    value={l.preco}
                    inputMode="decimal"
                    onChange={(e) => patch(i, { preco: e.target.value })}
                    className="w-full rounded-lg border border-nuvem-300 px-2 py-2 text-sm outline-none"
                  />
                </label>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-xs text-stone-500">
                  {faixas[i].min_qty >= 1 ? rotuloFaixa(faixas[i]) : "faixa incompleta"}
                  {produto && faixas[i].unit_price_cents > 0 && (
                    <>
                      {" "}
                      · economia de {money(Math.max(0, produto.rent_price_cents - faixas[i].unit_price_cents))} por
                      unidade
                    </>
                  )}
                </span>
                {linhas.length > 1 && (
                  <button
                    type="button"
                    onClick={() => remover(i)}
                    className="rounded-lg p-1.5 text-red-600 hover:bg-red-50"
                    aria-label="Remover faixa"
                  >
                    <Icon name="fechar" className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={adicionar}
          className="mt-3 rounded-xl border border-marca-300 px-3 py-2 text-sm font-semibold text-marca-600"
        >
          + Adicionar faixa
        </button>

        {erros.length > 0 && (
          <Alerta tone="vermelho" title="Corrija antes de salvar">
            <ul className="list-disc pl-4">
              {erros.map((p, i) => (
                <li key={i}>{p.mensagem}</li>
              ))}
            </ul>
          </Alerta>
        )}
        {erros.length === 0 && avisos.length > 0 && (
          <Alerta tone="ambar" title="Confira">
            <ul className="list-disc pl-4">
              {avisos.map((p, i) => (
                <li key={i}>{p.mensagem}</li>
              ))}
            </ul>
          </Alerta>
        )}

        {produto && erros.length === 0 && (
          <div className="mt-3 rounded-xl bg-nuvem-100 p-3">
            <p className="mb-1 text-xs font-semibold uppercase text-stone-500">Como vai ficar</p>
            <ul className="space-y-0.5 text-sm">
              {faixas.map((f, i) => {
                const exemplo = f.min_qty;
                return (
                  <li key={i} className="flex justify-between gap-3">
                    <span className="text-stone-600">{rotuloFaixa(f)}</span>
                    <span className="font-semibold text-tinta-900">
                      {money(f.unit_price_cents)} cada · {exemplo} un. = {money(exemplo * f.unit_price_cents)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </section>

      <div className="flex gap-2">
        <SubmitButton disabled={erros.length > 0}>{submitLabel}</SubmitButton>
        <Link href="/promocoes" className="rounded-xl border border-nuvem-300 px-4 py-2.5 text-sm font-semibold">
          Cancelar
        </Link>
      </div>
    </form>
  );
}
