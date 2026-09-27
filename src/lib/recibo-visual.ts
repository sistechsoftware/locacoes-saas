/**
 * Utilidades de renderizacao do recibo.
 *
 * Fica fora de recibos.ts (que e server-only) para que testes e componentes
 * de tela compartilhem as mesmas funcoes sem arrastar o acesso a banco.
 * Nada aqui toca em dados: sao funcoes puras de formatacao.
 */

const UNIDADES = ["", "um", "dois", "três", "quatro", "cinco", "seis", "sete", "oito", "nove"];
const ESPECIAIS = ["dez", "onze", "doze", "treze", "quatorze", "quinze", "dezesseis", "dezessete", "dezoito", "dezenove"];
const DEZENAS = ["", "", "vinte", "trinta", "quarenta", "cinquenta", "sessenta", "setenta", "oitenta", "noventa"];
const CENTENAS = ["", "cento", "duzentos", "trezentos", "quatrocentos", "quinhentos", "seiscentos", "setecentos", "oitocentos", "novecentos"];

/** Número por extenso até 999.999.999.999, sem dependências. */
function extensoInteiro(n: number): string {
  if (n === 0) return "zero";
  if (n === 100) return "cem";
  if (n < 10) return UNIDADES[n];
  if (n < 20) return ESPECIAIS[n - 10];
  if (n < 100) {
    const d = Math.floor(n / 10);
    const u = n % 10;
    return u ? `${DEZENAS[d]} e ${UNIDADES[u]}` : DEZENAS[d];
  }
  if (n < 1000) {
    const c = Math.floor(n / 100);
    const resto = n % 100;
    return resto ? `${CENTENAS[c]} e ${extensoInteiro(resto)}` : CENTENAS[c];
  }
  const grupos: { divisor: number; singular: string; plural: string }[] = [
    { divisor: 1_000_000_000, singular: "bilhão", plural: "bilhões" },
    { divisor: 1_000_000, singular: "milhão", plural: "milhões" },
    { divisor: 1_000, singular: "mil", plural: "mil" },
  ];
  for (const g of grupos) {
    if (n >= g.divisor) {
      const q = Math.floor(n / g.divisor);
      const resto = n % g.divisor;
      const sufixo = g.divisor === 1_000 && q === 1 ? "mil" : `${extensoInteiro(q)} ${q === 1 ? g.singular : g.plural}`;
      if (!resto) return sufixo;
      // Portuguese comercial: "mil e cem", "mil e vinte", but "mil duzentos e cinquenta"
      // — "e" between group and remainder only for exact hundreds or below a hundred
      const ligacao = resto < 100 || resto % 100 === 0 ? " e " : " ";
      return `${sufixo}${ligacao}${extensoInteiro(resto)}`;
    }
  }
  return String(n);
}

/** Valor monetário por extenso: 125080 -> "mil duzentos e cinquenta reais e oitenta centavos". */
export function valorPorExtenso(cents: number | null | undefined): string {
  const n = Math.max(0, Math.round(cents ?? 0));
  const reais = Math.floor(n / 100);
  const centavos = n % 100;
  const partes: string[] = [];
  if (reais > 0 || centavos === 0) {
    partes.push(`${extensoInteiro(reais)} ${reais === 1 ? "real" : "reais"}`);
  }
  if (centavos > 0) {
    partes.push(`${extensoInteiro(centavos)} ${centavos === 1 ? "centavo" : "centavos"}`);
  }
  return partes.join(" e ");
}

/* ------------------------------ tamanhos ---------------------------- */

/**
 * Tamanhos de recibo.
 *
 * A configuração vive na tabela settings (KV), como os demais ajustes da
 * empresa — nenhuma migration nova. O padrão A4 preserva o comportamento
 * atual das instalações existentes; os formatos compactos são para quem
 * imprime em bobina/folha cortada. As medidas são em milímetros, direto do
 * CSS (@page size e largura da folha), então o que se vê na tela é o que sai
 * no papel — sem depender de o usuário ajustar escala na caixa de impressão.
 *
 * A lista é fechada e pequena de propósito: formatos que ninguém usa só
 * aumentam a superfície de configuração sem valor real. Personalizado cobre
 * o resto, com validação para não nascer folha impossível.
 */
export type TamanhoReciboKey = "a4" | "meio_a4" | "quarto_a4" | "personalizado";

export type TamanhoRecibo = {
  key: TamanhoReciboKey;
  label: string;
  larguraMm: number;
  alturaMm: number | null;
  /** Formato contínuo (altura livre): @page sem altura, folha sem altura fixa. */
  continuo: boolean;
  /** Escala visual da pré-visualização (largura da coluna em px). */
  previewPx: number;
};

export const TAMANHOS_RECIBO: Record<TamanhoReciboKey, TamanhoRecibo> = {
  a4: { key: "a4", label: "A4 (210 × 297 mm)", larguraMm: 210, alturaMm: 297, continuo: false, previewPx: 150 },
  meio_a4: { key: "meio_a4", label: "½ A4 (210 × 148,5 mm)", larguraMm: 210, alturaMm: 148.5, continuo: false, previewPx: 150 },
  quarto_a4: { key: "quarto_a4", label: "¼ A4 (105 × 148,5 mm)", larguraMm: 105, alturaMm: 148.5, continuo: false, previewPx: 120 },
  personalizado: { key: "personalizado", label: "Personalizado", larguraMm: 105, alturaMm: 148, continuo: false, previewPx: 120 },
};

/** O pessoal escolhe pelo label; o banco guarda a chave. */
export const TAMANHOS_RECIBO_LISTA = Object.values(TAMANHOS_RECIBO);

const MM_MIN = 50;
const MM_MAX = 297;

/**
 * Lê a configuração de tamanho a partir dos valores salvos. Valores salvos
 * inválidos, ausentes ou de versões antigas caem no padrão A4 — instalacões
 * existentes continuam saindo exatamente como sempre saíram.
 */
export function tamanhoRecibo(settings: Record<string, string>, overrides?: { larguraMm?: string; alturaMm?: string }): TamanhoRecibo {
  const key = settings.recibo_tamanho as TamanhoReciboKey | undefined;
  if (key && key !== "personalizado" && TAMANHOS_RECIBO[key]) return TAMANHOS_RECIBO[key];
  if (key !== "personalizado") return TAMANHOS_RECIBO.a4;

  // personalizado: dimensões salvas em settings; overrides ganham quando
  // presentes (a própria aba de configuração mostra o que o usuário digitou
  // antes de salvar)
  const parse = (v: string | undefined, fallback: number) => {
    const n = Math.round(Number(String(v ?? "").replace(",", ".")) * 100) / 100;
    return Number.isFinite(n) ? n : fallback;
  };
  const largura = parse(overrides?.larguraMm ?? settings.recibo_largura_mm, TAMANHOS_RECIBO.personalizado.larguraMm);
  const altura = parse(overrides?.alturaMm ?? settings.recibo_altura_mm, TAMANHOS_RECIBO.personalizado.alturaMm!);
  return {
    key: "personalizado",
    label: `Personalizado (${largura} × ${altura} mm)`,
    larguraMm: largura,
    alturaMm: altura,
    continuo: false,
    previewPx: largura > 150 ? 150 : 120,
  };
}

/**
 * Normaliza e valida dimensões personalizadas informadas pelo usuário.
 * Devolve o erro em texto (padrão das demais actions) ou as medidas limpas.
 */
export function validarDimensoesRecibo(larguraMm: string | number, alturaMm: string | number): { erro: string } | { larguraMm: number; alturaMm: number } {
  const parse = (v: string | number) => {
    const n = Math.round(Number(String(v).replace(",", ".")) * 100) / 100;
    return Number.isFinite(n) ? n : NaN;
  };
  const largura = parse(larguraMm);
  const altura = parse(alturaMm);
  if (!Number.isFinite(largura) || !Number.isFinite(altura)) return { erro: "Informe largura e altura em milímetros (números)." };
  if (largura < MM_MIN || altura < MM_MIN) return { erro: `Dimensões mínimas: ${MM_MIN} × ${MM_MIN} mm.` };
  if (largura > MM_MAX || altura > MM_MAX) return { erro: `Dimensões máximas: ${MM_MAX} × ${MM_MAX} mm.` };
  return { larguraMm: largura, alturaMm: altura };
}

/** Rótulo legível da forma de pagamento gravada no lançamento. */
export const FORMA_LABEL: Record<string, string> = {
  pix: "Pix",
  dinheiro: "Dinheiro",
  cartao: "Cartão",
  transferencia: "Transferência",
  outros: "Outros",
};

export function formaLabel(method: string | null | undefined): string {
  if (!method) return "Não informada";
  return FORMA_LABEL[method] ?? method;
}

/** Tira acentos e símbolos para o nome do arquivo PDF (mesma regra do orçamento). */
export function sanitizarNomeArquivo(texto: string | null | undefined): string {
  return (texto ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}
