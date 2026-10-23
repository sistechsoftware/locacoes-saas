/**
 * Regras financeiras em funcoes puras: parcelamento, situacao de uma parcela e
 * fechamento de caixa.
 *
 * Nao acessa banco. Isso mantem a regra num lugar so e permite testar as contas
 * sem infraestrutura, que e onde erram os sistemas financeiros.
 *
 * Todo dinheiro circula em centavos inteiros. Somar reais em ponto flutuante
 * acumula erro e faz o saldo deixar de fechar.
 */

export type Direcao = "receber" | "pagar";

/** Situacao derivada, nunca guardada: previsto e realizado nao podem divergir. */
export type SituacaoParcela = "quitada" | "parcial" | "vencida" | "aberta" | "cancelada";

/**
 * Divide um total em parcelas iguais, jogando a sobra dos centavos na primeira.
 *
 * R$ 1.000 em 3x nao da parcelas iguais: 333,33 x 3 = 999,99. A diferenca vai
 * para a primeira parcela, entao a soma sempre bate com o total contratado.
 */
export function dividirParcelas(totalCents: number, quantidade: number): number[] {
  const total = Math.max(0, Math.round(totalCents));
  const n = Math.max(1, Math.floor(quantidade));
  const base = Math.floor(total / n);
  const sobra = total - base * n;
  return Array.from({ length: n }, (_, i) => (i === 0 ? base + sobra : base));
}

/** Vencimentos mensais a partir da primeira data, preservando o dia possivel. */
export function vencimentos(primeira: string, quantidade: number): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(primeira);
  if (!m) return Array.from({ length: quantidade }, () => primeira);
  const ano = +m[1];
  const mes = +m[2] - 1;
  const dia = +m[3];

  return Array.from({ length: Math.max(1, quantidade) }, (_, i) => {
    // dia 31 em mes de 30 cai no ultimo dia do mes, sem escorregar para o proximo
    const ultimo = new Date(Date.UTC(ano, mes + i + 1, 0)).getUTCDate();
    const d = new Date(Date.UTC(ano, mes + i, Math.min(dia, ultimo)));
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  });
}

export type Parcela = {
  installment: number;
  installments_total: number;
  amount_cents: number;
  due_date: string;
};

/** Monta as parcelas de uma obrigacao: valores somam o total, um vencimento cada. */
export function montarParcelas(totalCents: number, quantidade: number, primeiroVencimento: string): Parcela[] {
  const valores = dividirParcelas(totalCents, quantidade);
  const datas = vencimentos(primeiroVencimento, valores.length);
  return valores.map((amount_cents, i) => ({
    installment: i + 1,
    installments_total: valores.length,
    amount_cents,
    due_date: datas[i],
  }));
}

/**
 * Situacao de uma parcela a partir do que ja foi movimentado.
 *
 * O valor liquidado vem da soma dos lancamentos de caixa ligados a ela, e nao
 * de um campo proprio: assim nao existe o caso de o status dizer "quitada" com
 * dinheiro faltando.
 */
export function situacaoParcela(
  entry: { amount_cents: number; due_date: string; status?: string },
  liquidadoCents: number,
  hoje: string,
): SituacaoParcela {
  if (entry.status === "cancelada") return "cancelada";
  if (liquidadoCents >= entry.amount_cents) return "quitada";
  if (liquidadoCents > 0) return entry.due_date < hoje ? "vencida" : "parcial";
  return entry.due_date < hoje ? "vencida" : "aberta";
}

/** Quanto ainda falta nesta parcela. Nunca negativo. */
export function saldoParcela(amountCents: number, liquidadoCents: number): number {
  return Math.max(0, amountCents - liquidadoCents);
}

/* ------------------------------------------------------------------ */
/* Compras                                                             */
/* ------------------------------------------------------------------ */

export type ItemCompra = { qty: number; unit_price_cents: number; discount_cents: number };

/** Subtotal de um item: quantidade x valor, menos o desconto da linha. */
export function subtotalItem(item: ItemCompra): number {
  return Math.max(0, Math.round(item.qty * item.unit_price_cents - item.discount_cents));
}

/** Soma dos itens e total da compra depois do desconto geral. */
export function subtotaisCompra(itens: ItemCompra[], descontoCents: number) {
  const itensTotal = itens.reduce((soma, i) => soma + subtotalItem(i), 0);
  return { itensTotal, total: Math.max(0, itensTotal - Math.max(0, descontoCents)) };
}

/**
 * Quanto falta somar ao estoque de cada item.
 *
 * Guardando o que ja foi aplicado, salvar a mesma compra de novo nao duplica
 * a entrada, e mudar a quantidade movimenta apenas a diferenca: de 5 para 7
 * entram 2; de 5 para 3 saem 2.
 */
export function ajusteDeEstoque(
  itens: { product_id: number; qty: number; stock_applied_qty: number }[],
  aplicar: boolean,
): { product_id: number; delta: number }[] {
  const porProduto = new Map<number, number>();
  for (const i of itens) {
    // sem aplicar estoque, o alvo e zero: cancelar devolve o que entrou
    const alvo = aplicar ? i.qty : 0;
    const delta = alvo - i.stock_applied_qty;
    if (delta !== 0) porProduto.set(i.product_id, (porProduto.get(i.product_id) ?? 0) + delta);
  }
  return [...porProduto.entries()]
    .filter(([, delta]) => delta !== 0)
    .map(([product_id, delta]) => ({ product_id, delta }));
}

/* ------------------------------------------------------------------ */
/* Caixa                                                               */
/* ------------------------------------------------------------------ */

/**
 * Saldo de uma conta: o inicial mais o que entrou, menos o que saiu.
 *
 * Saldo nao e um campo guardado. Recalcular a partir das movimentacoes evita
 * o caso classico de o numero na tela deixar de bater com a soma dos extratos.
 */
export function saldoConta(inicialCents: number, entradasCents: number, saidasCents: number): number {
  return inicialCents + entradasCents - saidasCents;
}

/** Resultado do periodo: o que foi efetivamente recebido menos o efetivamente pago. */
export function resultadoPeriodo(recebidoCents: number, pagoCents: number): number {
  return recebidoCents - pagoCents;
}

/* ------------------------------------------------------------------ */
/* Transferencia entre contas                                          */
/* ------------------------------------------------------------------ */

/**
 * A transferencia e um evento DUPLO do caixa, nao uma receita e uma despesa:
 * saida = pagamento negativo na conta de origem; entrada = pagamento positivo
 * na de destino. Como saldo de conta e sempre inicial + entradas - saidas, os
 * dois lados aparecem nele sem nenhuma consulta nova — e o saldo consolidado
 * nao se altera, porque o que sai de uma entra na outra.
 */

/** Validacao compartilhada pelos caminhos de criar e editar. */
export function validarTransferencia(
  origemId: number,
  destinoId: number,
  valorCents: number,
  data: string,
): string | null {
  if (!origemId || !destinoId) return "Escolha a conta de origem e a conta de destino.";
  if (origemId === destinoId) return "Origem e destino não podem ser a mesma conta.";
  if (!Number.isFinite(valorCents) || valorCents <= 0) return "Informe um valor maior que zero para transferir.";
  if (valorCents !== Math.round(valorCents)) return "O valor da transferência não pode ter fração de centavo.";
  if (!/^\d{4}-\d{2}-\d{2}/.test(data ?? "")) return "Informe a data da transferência.";
  return null;
}

/**
 * Predicado SQL que separa lancamento comum de transferencia.
 *
 * Sem alias de proposito: vale tanto em consulta com `FROM payments p`
 * (Financeiro) quanto com `FROM payments` puro (relatorios, dashboard).
 */
export const SQL_NAO_TRANSFERENCIA = "transfer_group IS NULL";

/**
 * Descricao de cada lado no extrato, a partir dos NOMES no momento da
 * transferencia: renomear a conta depois nao reescreve o que foi registrado.
 */
export function descricaoTransferencia(direcao: "saida" | "entrada", contaContraria: string): string {
  return direcao === "saida" ? `Transferência para ${contaContraria}` : `Transferência recebida de ${contaContraria}`;
}

/**
 * Token de idempotência do formulário: `TF-<company_id>-<uuid>`. O prefixo da
 * empresa impede que dois tenants gerem o mesmo grupo; o uuid aleatorio faz
 * do token uma chave de deduplicação — reenviar o MESMO formulário encontra
 * o mesmo grupo e é recusado pelo índice único de débito (0049); um envio
 * novo nasce com token novo na próxima renderização da página.
 */
export function novoGrupoTransferencia(companyId: number): string {
  return `TF-${companyId}-${crypto.randomUUID()}`;
}

/** O token é plausível E pertence a esta empresa? Nunca confiar no cliente. */
export function grupoTransferenciaValido(grupo: unknown, companyId: number): boolean {
  if (typeof grupo !== "string") return false;
  return /^TF-\d+-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(grupo) &&
    grupo.startsWith(`TF-${companyId}-`);
}
