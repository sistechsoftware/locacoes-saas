/**
 * Preço por período — resolução SERVER-SIDE (Fase 1 da auditoria de períodos).
 *
 * Regra: o cliente NUNCA envia período. `readItems` (reserva/orçamento) só
 * aceita product_id, qty, unit_price e discount; daqui sai o period_qty
 * gravado, sempre derivado da janela [delivery_at, pickup_at] da própria
 * escrita — o servidor é a única fonte da duração cobrada.
 *
 * Precedência da modalidade (decisão nº 7 aprovada):
 *   produto (pricing_mode) > default da empresa (pricing_default_mode) > 'fixo'.
 *
 * Modalidade explícita vindo do banco (linha de orçamento convertido em
 * reserva) é preservada: a conversão não reprica o que já foi negociado.
 */
import "server-only";
import { all } from "./db";
import { settingsDaEmpresa } from "./settings";
import { diasCobrados } from "./format";

export type ModoCobranca = "fixo" | "diaria";

export type ItemComPreco = {
  product_id: number;
  qty: number;
  unit_price_cents: number;
  discount_cents: number;
  pricing_mode: ModoCobranca;
  period_qty: number;
};

/** Só aceita modalidade conhecida — lixo vindo de qualquer origem vira null. */
function modoValido(v: unknown): ModoCobranca | null {
  return v === "fixo" || v === "diaria" ? v : null;
}

/**
 * Resolve modalidade e período de cada linha para gravação.
 *
 * - period_qty SEMPRE recalculado da janela: linha 'diaria' cobra os dias de
 *   calendário entre entrega e retirada (mínimo 1); linha 'fixo' cobra 1 —
 *   fórmula antiga qty × unit × 1 − discount, bit a bit idêntica.
 * - pricing_mode preservado quando a linha já o traz do banco (conversão de
 *   orçamento); caso contrário resolve produto > empresa > 'fixo'.
 */
export async function aplicarPrecos<
  T extends {
    product_id: number;
    qty: number;
    unit_price_cents?: number;
    discount_cents?: number;
    pricing_mode?: unknown;
    period_qty?: unknown;
  },
>(items: T[], janela: { delivery_at?: string | null; pickup_at?: string | null }, companyId: number): Promise<ItemComPreco[]> {
  if (!items.length) return [];
  const [produtos, settings] = await Promise.all([
    all<{ id: number; pricing_mode: string | null }>(`SELECT id, pricing_mode FROM products WHERE company_id = ?`, [companyId]),
    settingsDaEmpresa(companyId),
  ]);
  const padrao: ModoCobranca = settings.pricing_default_mode === "diaria" ? "diaria" : "fixo";
  const modoProduto = new Map<number, ModoCobranca | null>(produtos.map((p) => [p.id, modoValido(p.pricing_mode)]));
  const dias = diasCobrados(janela.delivery_at, janela.pickup_at);

  return items.map((i) => {
    const modo: ModoCobranca = modoValido(i.pricing_mode) ?? modoProduto.get(i.product_id) ?? padrao;
    return {
      product_id: i.product_id,
      qty: i.qty,
      unit_price_cents: i.unit_price_cents ?? 0,
      discount_cents: i.discount_cents ?? 0,
      pricing_mode: modo,
      period_qty: modo === "diaria" ? dias : 1,
    };
  });
}
