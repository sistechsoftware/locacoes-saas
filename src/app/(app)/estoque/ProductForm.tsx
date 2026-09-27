"use client";
import { useState } from "react";
import { useActionState } from "react";
import { Alerta, Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { Icon } from "@/components/Icons";
import { money } from "@/lib/format";

type Action = (prev: string | null, fd: FormData) => Promise<string | null>;

export type SimpleProduct = {
  id: number;
  name: string;
  code: string;
  total_qty: number;
  rent_price_cents: number;
};

type ComponentRow = { product_id: number; quantity: number };

export default function ProductForm({
  action,
  product,
  categories,
  simpleProducts,
  components: initialComponents = [],
  submitLabel = "Salvar Produto",
}: {
  action: Action;
  product?: any;
  categories: { id: number; name: string }[];
  simpleProducts: SimpleProduct[];
  components?: ComponentRow[];
  submitLabel?: string;
}) {
  const [error, formAction] = useActionState(action, null);
  const v = product ?? {};
  const [kind, setKind] = useState<"simples" | "kit">(v.kind === "kit" ? "kit" : "simples");
  const [components, setComponents] = useState<ComponentRow[]>(initialComponents);

  // um produto nao pode ser componente de si mesmo
  const escolhas = simpleProducts.filter((p) => p.id !== v.id);
  const byId = new Map(escolhas.map((p) => [p.id, p]));
  const disponiveis = escolhas.filter((p) => !components.some((c) => c.product_id === p.id));

  const addComponent = (productId: number) => {
    if (!productId || components.some((c) => c.product_id === productId)) return;
    setComponents([...components, { product_id: productId, quantity: 1 }]);
  };
  const patch = (index: number, quantity: number) =>
    setComponents(components.map((c, i) => (i === index ? { ...c, quantity } : c)));
  const remove = (index: number) => setComponents(components.filter((_, i) => i !== index));

  // previsao de quantos kits dariam para montar com o estoque total cadastrado
  const capacidade = components.length
    ? Math.min(
        ...components.map((c) => Math.floor((byId.get(c.product_id)?.total_qty ?? 0) / Math.max(1, c.quantity))),
      )
    : 0;

  return (
    <form action={formAction} className="space-y-4">
      {product && <input type="hidden" name="id" value={product.id} />}
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="components" value={JSON.stringify(kind === "kit" ? components : [])} />

      <Field label="Tipo de produto">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <TipoOpcao
            checked={kind === "simples"}
            onSelect={() => setKind("simples")}
            titulo="Produto simples"
            descricao="Possui estoque físico próprio (mesa, cadeira, forro)."
          />
          <TipoOpcao
            checked={kind === "kit"}
            onSelect={() => setKind("kit")}
            titulo="Kit / Produto composto"
            descricao="Sem estoque próprio: consome os componentes ao ser alugado."
          />
        </div>
      </Field>

      <Grid>
        <Field label="Código *" hint="Prefixo das unidades (MESA-001, CAD-001).">
          <input name="code" defaultValue={v.code ?? ""} className="campo uppercase" required />
        </Field>
        <Field label="Nome *">
          <input name="name" defaultValue={v.name ?? ""} className="campo" required />
        </Field>
        <Field label="Categoria">
          <select name="category_id" defaultValue={v.category_id ?? ""} className="campo">
            <option value="">Sem categoria</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>

        {kind === "simples" ? (
          <Field label="Quantidade total *">
            <input name="total_qty" type="number" min={0} defaultValue={v.total_qty ?? 0} className="campo" required />
          </Field>
        ) : (
          <Field label="Quantidade total" hint="O kit não tem estoque próprio: vem dos componentes.">
            <input value={capacidade ? `${capacidade} kit(s): capacidade teórica, sem reservas/manutenção` : "definido pelos componentes"} className="campo" disabled />
          </Field>
        )}

        <Field label="Estoque mínimo" hint="Gera alerta quando o disponível fica abaixo.">
          <input name="min_qty" type="number" min={0} defaultValue={v.min_qty ?? 0} className="campo" />
        </Field>
        <Field
          label="Valor de locação (R$)"
          hint={kind === "kit" ? "Preço próprio do kit, independente dos componentes." : undefined}
        >
          <input
            name="rent_price"
            defaultValue={((v.rent_price_cents ?? 0) / 100).toFixed(2)}
            inputMode="decimal"
            className="campo"
          />
        </Field>
        <Field label="Valor de reposição (R$)">
          <input
            name="replace_price"
            defaultValue={((v.replace_cents ?? 0) / 100).toFixed(2)}
            inputMode="decimal"
            className="campo"
          />
        </Field>
        <Field label="Foto (URL)">
          <input name="photo" defaultValue={v.photo ?? ""} className="campo" placeholder="https://..." />
        </Field>
      </Grid>

      {kind === "kit" && (
        <section className="rounded-xl border border-nuvem-300 bg-nuvem-50 p-3">
          <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-stone-600">Composição do kit</h3>

          {components.length === 0 ? (
            <p className="rounded-xl border border-dashed border-nuvem-300 bg-white px-3 py-5 text-center text-sm text-stone-500">
              Nenhum componente. Adicione ao menos um produto simples.
            </p>
          ) : (
            <div className="space-y-2">
              {components.map((c, index) => {
                const p = byId.get(c.product_id);
                return (
                  <div key={c.product_id} className="flex items-center gap-2 rounded-xl border border-nuvem-300 bg-white p-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-tinta-900">
                        {p?.name ?? `Produto ${c.product_id}`}
                      </span>
                      <span className="block text-xs text-stone-500">
                        {p?.code} · estoque {p?.total_qty ?? 0} un.
                      </span>
                    </span>
                    <label className="shrink-0">
                      <span className="sr-only">Quantidade</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={c.quantity}
                        onChange={(e) => patch(index, Math.max(1, Number(e.target.value) || 1))}
                        className="w-20 rounded-lg border border-nuvem-300 px-2 py-2 text-center text-sm outline-none"
                      />
                    </label>
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      className="shrink-0 rounded-lg p-1.5 text-red-600 hover:bg-red-50"
                      aria-label="Remover componente"
                    >
                      <Icon name="fechar" className="h-4 w-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <select
            value=""
            onChange={(e) => addComponent(Number(e.target.value))}
            className="campo mt-2"
            disabled={disponiveis.length === 0}
          >
            <option value="">
              {disponiveis.length ? "+ Adicionar componente…" : "Todos os produtos já foram adicionados"}
            </option>
            {disponiveis.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.total_qty} un. · {money(p.rent_price_cents)})
              </option>
            ))}
          </select>

          {components.length > 0 && (
            <p className="mt-2 text-xs text-stone-600">
              Com o estoque atual, dá-se para montar <b>{capacidade}</b> kit(s). Alugar 1 kit consome{" "}
              {components.map((c) => `${c.quantity} ${byId.get(c.product_id)?.name ?? ""}`).join(" + ")}.
            </p>
          )}

          <p className="mt-2 text-xs text-stone-500">
            Somente produtos simples podem ser componentes: kits dentro de kits não são permitidos.
          </p>
        </section>
      )}

      <Field label="Descrição">
        <textarea name="description" defaultValue={v.description ?? ""} rows={3} className="campo" />
      </Field>

      {error && <Alerta tone="vermelho">{error}</Alerta>}
      <SubmitButton className="w-full sm:w-auto">{submitLabel}</SubmitButton>
    </form>
  );
}

function TipoOpcao({
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
