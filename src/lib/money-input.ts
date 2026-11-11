/**
 * Formatação automática de valores monetários (estilo calculadora).
 *
 * O valor interno continua sendo SEMPRE centavos inteiros — a mesma unidade
 * que o banco e as APIs já usam. Este módulo cuida só do texto exibido no campo
 * e da leitura do que foi digitado, sem dependência de React ou de servidor:
 * as mesmas regras valem no navegador e nos testes.
 *
 * Regra de digitação: cada dígito novo entra pela direita e empurra as casas
 * decimais ("1" → R$ 0,01, "10" → R$ 0,10, "100" → R$ 1,00). Por isso o texto
 * digitado é lido apenas pelos DÍGITOS: pontos, vírgula e "R$" da máscara são
 * descartados, e zeros à esquerda não mudam o valor ("R$ 0,010" é 10 centavos).
 */

/** Teto de dígitos: R$ 9.999.999.999,99 — bem acima de qualquer locação. */
export const MAX_DIGITOS_MOEDA = 13;

const FORMATADOR_BRL = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Centavos → texto exibido no campo ("R$ 1.234,56"). null = campo vazio. */
export function textoMoeda(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  /* O Intl usa espaço não separável (U+00A0) entre "R$" e o número; o campo
   * exibe um espaço comum, igual ao restante da interface e ao padrão pedido. */
  return FORMATADOR_BRL.format(cents / 100).replace(/\u00a0/g, " ");
}

/**
 * Texto do campo → centavos, na leitura de calculadora.
 *
 * Devolve null para "vazio" (nenhum dígito ou só zeros): é o que permite apagar
 * o campo por completo e continuar digitando do zero. Negativo só é lido
 * quando o campo permite (o sinal vem do "-" da máscara ou de um valor colado).
 */
export function centavosDoTexto(
  texto: string,
  { permitirNegativo = false }: { permitirNegativo?: boolean } = {},
): number | null {
  const bruto = String(texto ?? "");
  const digitos = bruto.replace(/\D/g, "").slice(0, MAX_DIGITOS_MOEDA);
  const semZeros = digitos.replace(/^0+/, "");
  if (!semZeros) return null;
  const cents = Number(semZeros);
  if (!Number.isSafeInteger(cents)) return null;
  return permitirNegativo && bruto.includes("-") ? -cents : cents;
}

/**
 * Centavos → valor decimal enviado ao backend ("1234.56").
 *
 * Campo vazio continua vazio: o servidor interpreta com parseMoney, como
 * sempre fez. O formato é exatamente o que os formulários enviavam antes da
 * máscara, então nenhuma ação/validação precisou mudar.
 */
export function valorParaCampo(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || !Number.isFinite(cents)) return "";
  return (cents / 100).toFixed(2);
}
