"use client";
/**
 * Carrinho da loja pública — estado no localStorage, por slug.
 *
 * É só estado de UX: nada de valor é aceito daqui no servidor. A submissão
 * manda apenas product_id + qty e o backend recalcula preço, período,
 * frete e disponibilidade na hora de gravar.
 */
export type ItemCarrinho = {
  product_id: number;
  name: string;
  qty: number;
  unit_price_cents: number;
  photo?: string | null;
  max_qty?: number | null;
  pricing_mode?: string | null;
};

const chave = (slug: string) => `loja:${slug}:carrinho`;

export function lerCarrinho(slug: string): ItemCarrinho[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(chave(slug));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function salvarCarrinho(slug: string, itens: ItemCarrinho[]): void {
  try {
    window.localStorage.setItem(chave(slug), JSON.stringify(itens.slice(0, 50)));
  } catch {
    // storage indisponível (modo privado): o carrinho vive só em memória
  }
}

export function adicionar(slug: string, item: ItemCarrinho): ItemCarrinho[] {
  const itens = lerCarrinho(slug);
  const existe = itens.find((i) => i.product_id === item.product_id);
  if (existe) {
    const limite = item.max_qty ?? 999;
    existe.qty = Math.min(limite, existe.qty + Math.max(1, item.qty));
  } else {
    itens.push({ ...item, qty: Math.max(1, item.qty) });
  }
  salvarCarrinho(slug, itens);
  return itens;
}

export function alterarQty(slug: string, productId: number, qty: number): ItemCarrinho[] {
  const itens = lerCarrinho(slug);
  for (const i of itens) {
    if (i.product_id === productId) i.qty = Math.max(0, Math.min(i.max_qty ?? 999, Math.floor(qty)));
  }
  const limpos = itens.filter((i) => i.qty > 0);
  salvarCarrinho(slug, limpos);
  return limpos;
}

export function remover(slug: string, productId: number): ItemCarrinho[] {
  const itens = lerCarrinho(slug).filter((i) => i.product_id !== productId);
  salvarCarrinho(slug, itens);
  return itens;
}

export function limpar(slug: string): void {
  try {
    window.localStorage.removeItem(chave(slug));
  } catch {
    /* noop */
  }
}

/** Mesmo formato de dinheiro do servidor (centavos -> R$ 1.234,56). */
export const brl = (cents: number) =>
  `R$ ${(Number(cents || 0) / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
