/**
 * Utilitarios de busca para selecoes (clientes, reservas).
 *
 * Funcoes PURAS, sem acesso a servidor: sao usadas pelos Client Components
 * para filtrar em memoria as listas que o servidor ja carregou. Sem consultas
 * por tecla nao existe condicao de corrida: uma "resposta antiga" sobrescrevendo
 * uma recente e estruturalmente impossivel, porque nao ha resposta assincrona.
 *
 * A deduplicacao e a ultima barreira antes da tela: mesmo que o chamador monte
 * a lista com linhas repetidas (join, cadastro inconsistente), a saida fica
 * unica pela CHAVE DE IDENTIFICACAO do registro (id), nunca pelo texto.
 */

/** Minusculas, sem acentos, espacos colapsados. Nao altera o dado original. */
export function normalizarTexto(s: string | null | undefined): string {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Somente digitos. Usado para CPF/telefone/numero digitado com pontuacao. */
export function digitosDe(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

/** Opcao pesquisavel de um seletor. */
export type OpcaoSelecionavel = {
  /** Identificador do registro (string do id unico). Chave de deduplicacao. */
  value: string;
  /** Texto exibido na lista. */
  label: string;
  /** Texto pesquisavel por palavras. Padrao: o proprio label. */
  texto?: string;
  /** Campos pesquisaveis por sequencia de digitos (CPF, telefone, numero). */
  digitos?: string[];
};

/**
 * A opcao casa com o termo digitado?
 *
 *  - token alfabético (ex.: "joao"): precisa estar contido no texto, sem
 *    olhar acentos nem maiusculas ("JOAO" acha "João da Silva"). Varios tokens
 *    = todos precisam casar, em qualquer ordem ("silva joao" tambem acha).
 *  - token de digitos (ex.: "1234" ou "123.456"): qualquer pedaco SEM letras
 *    e com digitos e comparado por digitos, progressivamente: 1, 12, 123,
 *    1234... Segue casando ate o valor completo. Pontuacao digitada pelo
 *    usuario (pontos, tracos, parenteses, barras) e ignorada — so digitos
 *    comparam; o dado armazenado nao e alterado.
 */
export function opcaoCorresponde(op: OpcaoSelecionavel, termo: string): boolean {
  const termoNorm = normalizarTexto(termo);
  if (!termoNorm) return true;
  const alvo = normalizarTexto(op.texto ?? op.label);
  const camposDigitos = (op.digitos ?? []).map(digitosDe).filter(Boolean);

  for (const token of termoNorm.split(" ")) {
    if (!token) continue;
    const digitosToken = digitosDe(token);
    // sem letras e com digitos: busca por digitos (CPF, telefone, numero)
    if (digitosToken && !/[a-z]/.test(token)) {
      if (!camposDigitos.some((campo) => campo.includes(digitosToken))) return false;
    } else if (!alvo.includes(token)) {
      return false;
    }
  }
  return true;
}

/**
 * Filtra as opcoes pelo termo e GARANTE saida unica por `value`.
 *
 * A deduplicacao acontece aqui, na logica dos dados — nao escondendo nada na
 * tela. Primeira ocorrencia vence, ordem original preservada. Deterministico:
 * a mesma entrada produz sempre a mesma saida, em qualquer ordem de chamadas.
 */
export function filtrarOpcoes(options: OpcaoSelecionavel[], termo: string): OpcaoSelecionavel[] {
  const vistas = new Set<string>();
  const saida: OpcaoSelecionavel[] = [];
  for (const op of options) {
    if (vistas.has(op.value)) continue; // duplicado nem entra na comparacao
    vistas.add(op.value);
    if (opcaoCorresponde(op, termo)) saida.push(op);
  }
  return saida;
}

/**
 * Remove linhas repetidas de uma lista pela chave de identificacao.
 * Usado ao montar as opcoes a partir de consultas com join, para que um
 * cliente com varias reservas (ou repetido por qualquer motivo) gere UMA opcao.
 */
export function unicosPorId<T>(rows: T[], chave: (row: T) => string | number | null | undefined): T[] {
  const vistas = new Set<string>();
  const saida: T[] = [];
  for (const row of rows) {
    const k = chave(row);
    if (k === null || k === undefined || k === "") {
      saida.push(row); // sem chave nao ha como deduplicar; preserva
      continue;
    }
    const ks = String(k);
    if (vistas.has(ks)) continue;
    vistas.add(ks);
    saida.push(row);
  }
  return saida;
}
