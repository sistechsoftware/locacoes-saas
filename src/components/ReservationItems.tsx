import type { ItemResumo } from "@/lib/reservations";
import { pecasFisicas } from "@/lib/reservations";

/**
 * Itens de uma reserva do jeito que o cliente contratou.
 *
 * O que vale e o produto comercial ("5x Kit Mesa + 4 Cadeiras"), nunca uma
 * contagem generica de pecas. A composicao aparece embaixo, como apoio para
 * quem separa a carga, e nao substitui a quantidade comercial.
 *
 * Quando a reserva tem muitos produtos, o cartao mostraria uma parede de texto,
 * entao o resto fica atras de "Ver todos". Uso <details> em vez de modal para
 * funcionar sem JavaScript, no PWA instalado e na impressao.
 */
export function ReservationItems({ items, limite = 3 }: { items: ItemResumo[]; limite?: number }) {
  if (items.length === 0) return <p className="text-xs text-stone-400">Sem itens lançados.</p>;

  const visiveis = items.slice(0, limite);
  const escondidos = items.slice(limite);
  const pecas = pecasFisicas(items);
  const temKit = items.some((i) => i.componentes.length > 0);

  return (
    <div className="space-y-1">
      {visiveis.map((i) => (
        <Linha key={i.item_id} item={i} />
      ))}

      {escondidos.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer list-none text-xs font-semibold text-marca-600 hover:underline">
            <span className="group-open:hidden">Ver todos os {items.length} produtos</span>
            <span className="hidden group-open:inline">Ver menos</span>
          </summary>
          <div className="mt-1 space-y-1">
            {escondidos.map((i) => (
              <Linha key={i.item_id} item={i} />
            ))}
          </div>
        </details>
      )}

      {temKit && (
        <p className="pt-0.5 text-[0.68rem] text-stone-400">Total físico: {pecas} peças</p>
      )}
    </div>
  );
}

function Linha({ item }: { item: ItemResumo }) {
  return (
    <div className="text-xs leading-snug">
      <p className="font-semibold text-tinta-900">
        {item.qty}x {item.name}
      </p>
      {item.componentes.length > 0 && (
        <p className="text-stone-500">
          Composicao: {item.componentes.map((c) => `${c.qty}x ${c.name}`).join(" + ")}
        </p>
      )}
    </div>
  );
}
