/**
 * Desconto em R$ ou % (flexível, com memória da forma escolhida).
 *
 * O dinheiro cobrado continua sendo `discount_cents` em todas as telas,
 * relatórios e contratos — nada disso muda. Estas funções tratam só da
 * EXPRESSÃO digitada pelo operador ("10%", "12,5%"): o servidor valida e
 * normaliza o que vem do formulário, e as telas usam o rótulo
 * "10% (R$ 150,00)" para reabrir sem dúvida sobre o que foi combinado.
 *
 * Sem dependência de servidor: cliente e servidor compartilham as mesmas
 * regras (o form calcula em tempo real; o servidor só aceita o formato).
 */
import { money } from "./format";

export type ModoDesconto = "money" | "percent";

/** "10%" / "10,5%" / "10.5%" -> 10 | 10.5; fora da faixa ou lixo -> null. */
export function pctDeExpr(expr: unknown): number | null {
  if (typeof expr !== "string") return null;
  const m = expr.trim().match(/^(\d{1,3})(?:[.,](\d{1,2}))?%$/);
  if (!m) return null;
  const pct = Number(m[1]) + Number(`0.${m[2] ?? "0"}`);
  if (!(pct > 0) || pct > 100) return null;
  return pct;
}

/** Normaliza para o formato gravado: 10 -> "10%", 12.5 -> "12,5%". */
export function exprDePct(pct: number): string | null {
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) return null;
  const t = Math.round(pct * 100) / 100;
  return `${String(t).replace(".", ",")}%`;
}

/**
 * Percentual DIGITADO no form ("10", "10,5") -> número, com validação.
 * Vazio ou inválido -> null (o form mantém o valor anterior em vez de
 * aplicar zero em silêncio).
 */
export function pctDigitado(valor: unknown): number | null {
  const t = String(valor ?? "").trim().replace("%", "").replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null;
  const pct = Number(t);
  if (!(pct > 0) || pct > 100) return null;
  return pct;
}

/** Aceita só formato de percentual (normalizado); qualquer outro texto vira null. */
export function exprValida(raw: unknown): string | null {
  return exprDePct(pctDeExpr(raw) ?? NaN);
}

/** Centavos de um percentual sobre a base, sempre limitado à própria base. */
export function descontoDePct(base: number, pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0 || base <= 0) return 0;
  return Math.min(Math.round((base * Math.min(pct, 100)) / 100), base);
}

/**
 * Rótulo exibido nas telas: "10% (R$ 150,00)" quando há expressão gravada,
 * senão só o dinheiro ("R$ 150,00") — o valor cobrado sempre aparece.
 */
export function rotuloDesconto(cents: number, expr: unknown): string {
  const pct = pctDeExpr(expr);
  return pct === null ? money(cents) : `${exprDePct(pct)} (${money(cents)})`;
}
