"use client";

export type ConflictView = {
  product_id: number;
  product: string;
  kind: "simples" | "kit";
  requested: number;
  available: number;
  missing: number;
  components?: { product_id: number; product: string; required: number; available: number; missing: number }[];
  holds?: { number: string; customer: string; qty: number }[];
};

/**
 * Detalhe dos conflitos de estoque.
 *
 * Para kits a mensagem fala na unidade que o usuario pediu ("2 kits"), e o
 * detalhe por componente explica qual produto fisico faltou.
 */
export default function ConflictList({ conflicts }: { conflicts: ConflictView[] }) {
  return (
    <ul className="mt-1 space-y-1.5 text-xs">
      {conflicts.map((c) => (
        <li key={c.product_id}>
          {c.kind === "kit" ? (
            <>
              <b>{c.product}</b>: estoque insuficiente para este kit. Disponível para esta operação:{" "}
              <b>{c.available} kit(s)</b>, pedido {c.requested}.
              {!!c.components?.length && (
                <span className="mt-0.5 block opacity-80">
                  {c.components
                    .map((x) => `${x.product}: precisa de ${x.required}, disponível ${x.available}`)
                    .join("; ")}
                </span>
              )}
            </>
          ) : (
            <>
              <b>{c.product}</b>: pedido {c.requested}, disponível {c.available} neste intervalo.
            </>
          )}
          {!!c.holds?.length && (
            <span className="mt-0.5 block opacity-80">
              Em uso por: {dedupe(c.holds).map((h) => `${h.number} (${h.customer}, ${h.qty})`).join("; ")}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Uma mesma reserva pode aparecer em varios componentes do kit. */
function dedupe(holds: NonNullable<ConflictView["holds"]>) {
  const map = new Map<string, { number: string; customer: string; qty: number }>();
  for (const h of holds) {
    const atual = map.get(h.number);
    if (atual) atual.qty += h.qty;
    else map.set(h.number, { ...h });
  }
  return [...map.values()];
}
