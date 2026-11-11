"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { Alerta, Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { Icon } from "@/components/Icons";
import { money, parseMoney } from "@/lib/format";
import { rotuloFaixa, validarFaixas, type Faixa } from "@/lib/promocoes";

type Produto = {
  id: number;
  name: string;
  code: string;
  rent_price_cents: number;
  kind?: string;
  category?: string | null;
  /** Promoções ativas que o cadastro já tem para o produto (dica de conflito). */
  promocoes?: { id: number; group_id?: number | null }[];
};
type Action = (prev: string | null, fd: FormData) => Promise<string | null>;

/** Faixa em edicao: os numeros ficam como texto para o campo aceitar vazio. */
type Linha = { min: string; max: string; preco: string };

export type GrupoEmEdicao = {
  id: number;
  name: string;
  active: boolean;
  starts_on: string | null;
  ends_on: string | null;
  tiers: Faixa[];
  product_ids: number[];
  promotions: { id: number; group_id?: number | null }[];
};

const paraFaixa = (l: Linha): Faixa => ({
  min_qty: Math.trunc(Number(l.min) || 0),
  max_qty: l.max.trim() === "" ? null : Math.trunc(Number(l.max) || 0),
  unit_price_cents: parseMoney(l.preco),
});

export default function PromotionForm({
  action,
  produtos,
  promocao,
  grupo,
  submitLabel = "Salvar Promoção",
}: {
  action: Action;
  produtos: Produto[];
  promocao?: any;
  grupo?: GrupoEmEdicao;
  submitLabel?: string;
}) {
  const [erro, formAction] = useActionState(action, null);
  // Grupo editado só pode ser editado como grupo (voltar a individual deixaria
  // produtos com a regra removida sem aviso; excluir/editar membro é no grupo).
  const [modo, setModo] = useState<"unico" | "grupo">(grupo ? "grupo" : "unico");
  const [productId, setProductId] = useState(String(promocao?.product_id ?? ""));
  const [selecionados, setSelecionados] = useState<number[]>(grupo?.product_ids ?? []);
  const [busca, setBusca] = useState("");
  const [categoria, setCategoria] = useState("");
  const base = promocao ?? grupo;
  const [ativa, setAtiva] = useState<boolean>(base ? !!base.active : true);

  const faixasIniciais: Faixa[] = (promocao?.tiers?.length ? promocao.tiers : grupo?.tiers) ?? [];
  const [linhas, setLinhas] = useState<Linha[]>(
    faixasIniciais.length
      ? faixasIniciais.map((t) => ({
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

  /* ----------------------- seleção múltipla ------------------------ */

  const categorias = [...new Set(produtos.map((p) => (p.category ?? "").trim()).filter(Boolean))].sort();
  const termo = busca.trim().toLowerCase();
  const filtrados = produtos.filter((p) => {
    if (categoria && (p.category ?? "").trim() !== categoria) return false;
    if (!termo) return true;
    return `${p.name} ${p.code}`.toLowerCase().includes(termo);
  });
  const selecionadosObj = selecionados
    .map((id) => produtos.find((p) => p.id === id))
    .filter((p): p is Produto => !!p);

  // Não sinaliza como "já tem promoção" as regras que são DESTA edição.
  const ignorar = new Set<number>([
    ...(grupo?.promotions ?? []).map((p) => p.id),
    ...(promocao ? [Number(promocao.id)] : []),
  ]);
  const temPromocaoDeFora = (p: Produto) =>
    (p.promocoes ?? []).some((x) => !ignorar.has(Number(x.id)));

  const alternar = (id: number) =>
    setSelecionados((atuais) => (atuais.includes(id) ? atuais.filter((x) => x !== id) : [...atuais, id]));
  const selecionarExibidos = () =>
    setSelecionados((atuais) => [...new Set([...atuais, ...filtrados.map((p) => p.id)])]);

  const semProduto = modo === "grupo" ? selecionados.length === 0 : !productId;
  const previsivel = modo === "grupo" ? selecionadosObj.length > 0 : !!produto;

  return (
    <form action={formAction} className="space-y-4">
      {promocao && <input type="hidden" name="id" value={promocao.id} />}
      {grupo && <input type="hidden" name="group_id" value={grupo.id} />}
      {modo === "grupo" && <input type="hidden" name="product_ids" value={JSON.stringify(selecionados)} />}
      <input type="hidden" name="tiers" value={JSON.stringify(faixas)} />
      <input type="hidden" name="active" value={ativa ? "1" : "0"} />

      {erro && <Alerta tone="vermelho" title="Não foi possível salvar">{erro}</Alerta>}

      <section className="cartao p-4">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Promoção</h2>

        {!grupo && (
          <div className="mb-3 inline-flex rounded-xl bg-nuvem-100 p-1">
            <button
              type="button"
              onClick={() => setModo("unico")}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
                modo === "unico" ? "bg-white text-tinta-900 shadow-sm" : "text-stone-600"
              }`}
            >
              Um produto
            </button>
            <button
              type="button"
              onClick={() => setModo("grupo")}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${
                modo === "grupo" ? "bg-white text-tinta-900 shadow-sm" : "text-stone-600"
              }`}
            >
              Vários produtos
            </button>
          </div>
        )}

        <Grid>
          {modo === "unico" ? (
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
          ) : (
            <div className="space-y-2 sm:col-span-2">
              <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1 basis-40">
                  <span className="rotulo">Pesquisar produto</span>
                  <div className="relative">
                    <Icon
                      name="busca"
                      className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400"
                    />
                    <input
                      value={busca}
                      onChange={(e) => setBusca(e.target.value)}
                      placeholder="Nome ou código…"
                      className="campo pl-9"
                    />
                  </div>
                </label>
                <label className="w-full sm:w-44">
                  <span className="rotulo">Categoria</span>
                  <select value={categoria} onChange={(e) => setCategoria(e.target.value)} className="campo">
                    <option value="">Todas</option>
                    {categorias.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={selecionarExibidos}
                  disabled={filtrados.length === 0}
                  className="rounded-xl border border-marca-300 px-3 py-2 text-sm font-semibold text-marca-600 disabled:opacity-50"
                >
                  Selecionar {categoria || "todos"} ({filtrados.length})
                </button>
              </div>

              <div className="max-h-64 overflow-auto rounded-xl border border-nuvem-300 bg-white">
                {filtrados.length === 0 ? (
                  <p className="p-3 text-sm text-stone-500">Nenhum produto encontrado.</p>
                ) : (
                  filtrados.map((p) => {
                    const marcado = selecionados.includes(p.id);
                    return (
                      <label
                        key={p.id}
                        className={`flex cursor-pointer items-center gap-2 border-b border-nuvem-100 px-3 py-2 text-sm last:border-0 ${
                          marcado ? "bg-marca-50" : ""
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={marcado}
                          onChange={() => alternar(p.id)}
                          className="h-4 w-4"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-semibold text-tinta-900">
                            {p.kind === "kit" ? "[KIT] " : ""}
                            {p.name}
                          </span>
                          <span className="block truncate text-xs text-stone-500">
                            {p.code}
                            {p.category ? ` · ${p.category}` : ""} · normal {money(p.rent_price_cents)}
                          </span>
                        </span>
                        {temPromocaoDeFora(p) && (
                          <span className="shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[0.65rem] font-semibold text-amber-800">
                            já tem promoção
                          </span>
                        )}
                      </label>
                    );
                  })
                )}
              </div>

              {selecionadosObj.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {selecionadosObj.map((p) => (
                    <span
                      key={p.id}
                      className="inline-flex items-center gap-1 rounded-full border border-marca-300 bg-marca-50 px-2 py-0.5 text-xs font-semibold text-marca-700"
                    >
                      {p.name}
                      <button
                        type="button"
                        onClick={() => alternar(p.id)}
                        className="rounded-full p-0.5 hover:bg-marca-100"
                        aria-label={`Remover ${p.name}`}
                      >
                        <Icon name="fechar" className="h-3 w-3" />
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={() => setSelecionados([])}
                    className="text-xs font-semibold text-stone-500 underline"
                  >
                    limpar seleção
                  </button>
                </div>
              )}

              <p className="text-xs text-stone-500">
                {selecionados.length} produto(s) selecionado(s). Cada um recebe a mesma regra e calcula pela{" "}
                <b>própria</b> quantidade — quantidades de produtos diferentes não são somadas.
              </p>
            </div>
          )}

          <Field label="Nome da promoção" hint="Opcional, só para você identificar na lista.">
            <input name="name" defaultValue={base?.name ?? ""} maxLength={120} className="campo" />
          </Field>
          <Field label="Início" hint="Deixe vazio para valer desde já.">
            <input type="date" name="starts_on" defaultValue={base?.starts_on ?? ""} className="campo" />
          </Field>
          <Field label="Fim" hint="Deixe vazio para não expirar.">
            <input type="date" name="ends_on" defaultValue={base?.ends_on ?? ""} className="campo" />
          </Field>
          <Field label="Observações" className="sm:col-span-2">
            <input name="notes" defaultValue={base?.notes ?? ""} maxLength={500} className="campo" />
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
                  {modo === "unico" && produto && faixas[i].unit_price_cents > 0 && (
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

        {previsivel && erros.length === 0 && (
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
            {modo === "grupo" && (
              <p className="mt-2 text-xs text-stone-500">
                Vale para {selecionados.length} produto(s). A faixa considerada é sempre a da quantidade de cada
                produto.
              </p>
            )}
          </div>
        )}
      </section>

      <div className="flex gap-2">
        <SubmitButton disabled={erros.length > 0 || semProduto}>{submitLabel}</SubmitButton>
        <Link href="/promocoes" className="rounded-xl border border-nuvem-300 px-4 py-2.5 text-sm font-semibold">
          Cancelar
        </Link>
      </div>
    </form>
  );
}
