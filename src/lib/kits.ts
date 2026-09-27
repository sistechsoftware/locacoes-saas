/**
 * Regra de composicao de produtos (kits), em funcoes puras.
 *
 * Este modulo NAO acessa banco de dados. Ele recebe a ficha dos produtos e a
 * disponibilidade fisica ja calculada, e devolve a expansao / capacidade /
 * conflitos. Isso mantem a regra num unico lugar (usada por reservas,
 * orcamentos, estoque e relatorios) e permite testar tudo sem infraestrutura.
 *
 * Conceito central: um kit NAO tem estoque proprio. Ele e apenas uma forma
 * comercial de vender seus componentes. Todo calculo de estoque acontece
 * sempre nos produtos fisicos (simples).
 */

export type ProductKind = "simples" | "kit";

export type Component = {
  product_id: number;
  quantity: number;
};

/** Ficha minima de um produto para efeito de composicao. */
export type ProductSpec = {
  id: number;
  name: string;
  kind: ProductKind;
  /** Vazio quando o produto e simples. */
  components: Component[];
};

export type Line = {
  product_id: number;
  qty: number;
};

export type SpecMap = Map<number, ProductSpec>;

export const isKit = (spec: ProductSpec | undefined): boolean =>
  !!spec && spec.kind === "kit" && spec.components.length > 0;

/* ------------------------------------------------------------------ */
/* Expansao                                                            */
/* ------------------------------------------------------------------ */

/**
 * Explode uma linha comercial nos produtos fisicos que ela consome.
 *
 * Produto simples:  5 Mesas          -> [{ Mesa, 5 }]
 * Kit (1 Mesa+4 Cad): 3 Kits         -> [{ Mesa, 3 }, { Cadeira, 12 }]
 *
 * Kits dentro de kits nao sao permitidos (ver validateComposition), portanto
 * a expansao tem sempre um unico nivel e nao pode entrar em recursao infinita.
 */
export function explodeLine(line: Line, specs: SpecMap): { product_id: number; qty: number }[] {
  const spec = specs.get(line.product_id);
  const qty = Number(line.qty) || 0;
  if (qty <= 0) return [];
  if (!isKit(spec)) return [{ product_id: line.product_id, qty }];
  return spec!.components
    .filter((c) => c.quantity > 0)
    .map((c) => ({ product_id: c.product_id, qty: qty * c.quantity }));
}

/**
 * Soma o consumo fisico total de varias linhas, misturando kits e produtos
 * individuais no mesmo pedido.
 *
 * 3 Kits + 5 Mesas + 10 Cadeiras -> { Mesa: 8, Cadeira: 22 }
 */
export function expandDemand(lines: Line[], specs: SpecMap): Map<number, number> {
  const demand = new Map<number, number>();
  for (const line of lines) {
    for (const part of explodeLine(line, specs)) {
      demand.set(part.product_id, (demand.get(part.product_id) ?? 0) + part.qty);
    }
  }
  return demand;
}

/** Consumo fisico de todas as linhas, exceto a de indice informado. */
function demandExcept(lines: Line[], index: number, specs: SpecMap): Map<number, number> {
  return expandDemand(
    lines.filter((_, i) => i !== index),
    specs,
  );
}

/* ------------------------------------------------------------------ */
/* Disponibilidade                                                     */
/* ------------------------------------------------------------------ */

/**
 * Quantos kits completos cabem na disponibilidade informada.
 *
 * Formula: menor valor entre (disponivel do componente / quantidade exigida),
 * sempre arredondado para baixo, porque so e possivel alugar kits inteiros.
 *
 * 15 Mesas e 58 Cadeiras, kit 1 Mesa + 4 Cadeiras:
 *   min( floor(15/1), floor(58/4) ) = min(15, 14) = 14 kits
 */
export function kitCapacity(spec: ProductSpec, available: Map<number, number>): number {
  const components = spec.components.filter((c) => c.quantity > 0);
  if (!components.length) return 0;
  let capacity = Infinity;
  for (const c of components) {
    const disponivel = Math.max(0, available.get(c.product_id) ?? 0);
    capacity = Math.min(capacity, Math.floor(disponivel / c.quantity));
  }
  return Math.max(0, capacity === Infinity ? 0 : capacity);
}

/**
 * Quantas unidades do produto (kit ou simples) cabem na disponibilidade.
 * Para produto simples e a propria disponibilidade fisica.
 */
export function unitsAvailable(spec: ProductSpec | undefined, available: Map<number, number>): number {
  if (!spec) return 0;
  if (isKit(spec)) return kitCapacity(spec, available);
  return Math.max(0, available.get(spec.id) ?? 0);
}

/** Disponibilidade restante depois de descontar um consumo. */
function subtract(available: Map<number, number>, demand: Map<number, number>): Map<number, number> {
  const rest = new Map(available);
  for (const [productId, qty] of demand) {
    rest.set(productId, (rest.get(productId) ?? 0) - qty);
  }
  return rest;
}

/* ------------------------------------------------------------------ */
/* Conflitos                                                           */
/* ------------------------------------------------------------------ */

export type ComponentShortage = {
  product_id: number;
  product: string;
  required: number;
  available: number;
  missing: number;
};

export type LineConflict = {
  product_id: number;
  product: string;
  kind: ProductKind;
  requested: number;
  /** Quanto seria possivel atender nesta operacao, mantendo as demais linhas. */
  available: number;
  missing: number;
  /** Detalhe por componente quando a linha e um kit. */
  components: ComponentShortage[];
};

/**
 * Verifica se as linhas cabem na disponibilidade fisica.
 *
 * A disponibilidade informada em `available` ja deve considerar o estoque
 * fisico menos tudo o que esta comprometido por outras reservas na janela
 * (a logica de reservas existente no sistema).
 *
 * O "disponivel" reportado em cada conflito e calculado mantendo as demais
 * linhas do pedido, respondendo a pergunta pratica: "quantos consigo colocar
 * nesta operacao?".
 */
export function computeConflicts(lines: Line[], specs: SpecMap, available: Map<number, number>): LineConflict[] {
  const conflicts: LineConflict[] = [];

  lines.forEach((line, index) => {
    const qty = Number(line.qty) || 0;
    if (qty <= 0) return;
    const spec = specs.get(line.product_id);
    if (!spec) return;

    const rest = subtract(available, demandExcept(lines, index, specs));
    const capacity = unitsAvailable(spec, rest);
    if (qty <= capacity) return;

    const components: ComponentShortage[] = isKit(spec)
      ? spec.components
          .filter((c) => c.quantity > 0)
          .map((c) => {
            const required = qty * c.quantity;
            const disponivel = Math.max(0, rest.get(c.product_id) ?? 0);
            return {
              product_id: c.product_id,
              product: specs.get(c.product_id)?.name ?? `Produto ${c.product_id}`,
              required,
              available: disponivel,
              missing: Math.max(0, required - disponivel),
            };
          })
          .filter((c) => c.missing > 0)
      : [];

    conflicts.push({
      product_id: spec.id,
      product: spec.name,
      kind: spec.kind,
      requested: qty,
      available: capacity,
      missing: qty - capacity,
      components,
    });
  });

  return conflicts;
}

/** Mensagem padrao apresentada ao usuario para um conflito. */
export function conflictText(c: LineConflict): string {
  if (c.kind === "kit") {
    const detalhe = c.components
      .map((x) => `${x.product}: precisa de ${x.required}, disponível ${x.available}`)
      .join("; ");
    return (
      `Estoque insuficiente para este kit. Disponível para esta operação: ${c.available} kits.` +
      (detalhe ? ` (${detalhe})` : "")
    );
  }
  return `${c.product}: pedido ${c.requested}, disponível ${c.available} neste intervalo.`;
}

/* ------------------------------------------------------------------ */
/* Validacao do cadastro                                               */
/* ------------------------------------------------------------------ */

/**
 * Valida a composicao de um kit.
 *
 * Decisao de arquitetura: componentes precisam ser produtos SIMPLES. Kits
 * dentro de kits ficam bloqueados explicitamente, o que torna impossivel por
 * construcao qualquer composicao circular (Kit A -> Kit B -> Kit A) e mantem a
 * expansao com um unico nivel.
 */
export function validateComposition(
  parentId: number | null,
  components: Component[],
  specs: SpecMap,
): string | null {
  if (!components.length) return "Um kit precisa de ao menos um componente.";

  const seen = new Set<number>();
  for (const c of components) {
    if (!c.product_id) return "Selecione o produto de cada componente.";
    if (!Number.isFinite(c.quantity) || c.quantity <= 0) {
      return "A quantidade de cada componente deve ser maior que zero.";
    }
    if (!Number.isInteger(c.quantity))      return "A quantidade de cada componente deve ser um número inteiro.";
    if (parentId && c.product_id === parentId) return "Um produto não pode ser componente de si mesmo.";
    if (seen.has(c.product_id)) return "O mesmo produto foi adicionado duas vezes na composicao.";
    seen.add(c.product_id);

    const spec = specs.get(c.product_id);
    if (!spec) return "Componente inválido: produto não encontrado.";
    if (spec.kind === "kit") {
      return `"${spec.name}" é um kit. Kits dentro de kits não são permitidos: use apenas produtos simples na composição.`;
    }
  }
  return null;
}

/** Monta o mapa de fichas a partir das linhas cruas vindas do banco. */
export function buildSpecMap(
  products: { id: number; name: string; kind?: string | null }[],
  components: { parent_product_id: number; component_product_id: number; quantity: number }[],
): SpecMap {
  const map: SpecMap = new Map();
  for (const p of products) {
    map.set(p.id, {
      id: p.id,
      name: p.name,
      kind: p.kind === "kit" ? "kit" : "simples",
      components: [],
    });
  }
  for (const c of components) {
    const parent = map.get(c.parent_product_id);
    if (!parent) continue;
    parent.components.push({ product_id: c.component_product_id, quantity: c.quantity });
  }
  return map;
}
