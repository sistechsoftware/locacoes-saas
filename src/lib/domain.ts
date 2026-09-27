/** Constantes de dominio: status, rotulos e cores. Compartilhado servidor/cliente. */

export type Tone = "cinza" | "ambar" | "verde" | "azul" | "roxo" | "vermelho" | "terracota";

export type StatusDef = { value: string; label: string; tone: Tone };

/* ------------------------------ reservas ---------------------------- */

export const RESERVATION_STATUS: StatusDef[] = [
  { value: "orcamento", label: "Orçamento", tone: "cinza" },
  { value: "pre_reserva", label: "Pré-reserva", tone: "ambar" },
  { value: "confirmada", label: "Confirmada", tone: "verde" },
  { value: "entregue", label: "Entregue", tone: "azul" },
  { value: "em_uso", label: "Em uso", tone: "roxo" },
  { value: "aguardando_retirada", label: "Aguardando retirada", tone: "ambar" },
  { value: "retirada", label: "Retirada", tone: "azul" },
  { value: "finalizada", label: "Finalizada", tone: "cinza" },
  { value: "cancelada", label: "Cancelada", tone: "vermelho" },
];

/** Status em que a reserva ainda ocupa equipamento do estoque. */
export const HOLDING_STATUSES = [
  "pre_reserva",
  "confirmada",
  "entregue",
  "em_uso",
  "aguardando_retirada",
] as const;

/** Status considerados ativos (contam em faturamento / listas operacionais). */
export const ACTIVE_STATUSES = [...HOLDING_STATUSES, "retirada", "finalizada"] as const;

/** Ordem do fluxo, usada para sugerir o proximo passo. */
export const RESERVATION_FLOW = [
  "pre_reserva",
  "confirmada",
  "entregue",
  "em_uso",
  "aguardando_retirada",
  "retirada",
  "finalizada",
] as const;

/* ------------------------------ orcamentos -------------------------- */

export const QUOTE_STATUS: StatusDef[] = [
  { value: "rascunho", label: "Rascunho", tone: "cinza" },
  { value: "enviado", label: "Enviado", tone: "azul" },
  { value: "aguardando", label: "Aguardando resposta", tone: "ambar" },
  { value: "aprovado", label: "Aprovado", tone: "verde" },
  { value: "recusado", label: "Recusado", tone: "vermelho" },
  { value: "convertido", label: "Convertido em reserva", tone: "roxo" },
];

/* ------------------------------ operacoes --------------------------- */

export const OPERATION_KINDS = [
  { value: "entrega", label: "Entrega", icon: "🚚", tone: "verde" as Tone },
  { value: "retirada", label: "Retirada", icon: "🔄", tone: "azul" as Tone },
  { value: "montagem", label: "Montagem", icon: "🛠️", tone: "ambar" as Tone },
  { value: "desmontagem", label: "Desmontagem", icon: "🧰", tone: "roxo" as Tone },
];

export const OPERATION_STATUS: StatusDef[] = [
  { value: "pendente", label: "Pendente", tone: "cinza" },
  { value: "confirmada", label: "Confirmada", tone: "azul" },
  { value: "em_rota", label: "Em rota", tone: "ambar" },
  { value: "no_local", label: "No local", tone: "roxo" },
  { value: "concluida", label: "Concluída", tone: "verde" },
  { value: "reagendada", label: "Reagendada", tone: "ambar" },
  { value: "cancelada", label: "Cancelada", tone: "vermelho" },
];

export const OPEN_OPERATION_STATUS = ["pendente", "confirmada", "em_rota", "no_local", "reagendada"];

/* ------------------------------ fretes ------------------------------ */

export const FREIGHT_STATUS: StatusDef[] = [
  { value: "orcamento", label: "Orçamento", tone: "cinza" },
  { value: "agendado", label: "Agendado", tone: "azul" },
  { value: "em_rota", label: "Em rota", tone: "ambar" },
  { value: "concluido", label: "Concluído", tone: "verde" },
  { value: "cancelado", label: "Cancelado", tone: "vermelho" },
];

/* ------------------------------ contratos --------------------------- */

export const CONTRACT_STATUS: StatusDef[] = [
  { value: "pendente", label: "Pendente", tone: "ambar" },
  { value: "enviado", label: "Enviado", tone: "azul" },
  { value: "assinado", label: "Assinado", tone: "verde" },
  { value: "encerrado", label: "Encerrado", tone: "cinza" },
  { value: "cancelado", label: "Cancelado", tone: "vermelho" },
];

/* ------------------------------ caucao ------------------------------ */

export const DEPOSIT_STATUS: StatusDef[] = [
  { value: "nao_recebida", label: "Não recebida", tone: "vermelho" },
  { value: "recebida", label: "Recebida", tone: "verde" },
  { value: "devolvida", label: "Devolvida", tone: "azul" },
  { value: "retida_parcial", label: "Retida parcialmente", tone: "ambar" },
  { value: "retida_integral", label: "Retida integralmente", tone: "vermelho" },
];

/* ------------------------------ equipamentos ------------------------ */

export const UNIT_STATUS: StatusDef[] = [
  { value: "disponivel", label: "Disponível", tone: "verde" },
  { value: "reservado", label: "Reservado", tone: "ambar" },
  { value: "alugado", label: "Alugado", tone: "azul" },
  { value: "manutencao", label: "Em manutenção", tone: "roxo" },
  { value: "danificado", label: "Danificado", tone: "vermelho" },
  { value: "baixado", label: "Baixado", tone: "cinza" },
];

/* ------------------------------ financeiro -------------------------- */

export const PAYMENT_METHODS = ["pix", "dinheiro", "cartao", "transferencia", "outros"];

export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  pix: "Pix",
  dinheiro: "Dinheiro",
  cartao: "Cartão",
  transferencia: "Transferência",
  outros: "Outros",
};

export const INCOME_CATEGORIES = ["Locacao", "Frete", "Montagem", "Caucao retida", "Outros"];

export const EXPENSE_CATEGORIES = [
  "Combustivel",
  "Manutencao",
  "Compra de equipamentos",
  "Limpeza",
  "Funcionarios",
  "Divulgacao",
  "Outros",
];

export const DEFAULT_CATEGORIES = ["Mesas", "Cadeiras", "Forros", "Brinquedos", "Equipamentos", "Outros"];

/* ------------------------------ helpers ----------------------------- */

const index = (defs: StatusDef[]) => Object.fromEntries(defs.map((d) => [d.value, d]));

const ALL_STATUS: Record<string, StatusDef> = {
  ...index(RESERVATION_STATUS),
  ...index(QUOTE_STATUS),
  ...index(OPERATION_STATUS),
  ...index(FREIGHT_STATUS),
  ...index(CONTRACT_STATUS),
  ...index(DEPOSIT_STATUS),
  ...index(UNIT_STATUS),
};

export function statusDef(defs: StatusDef[], value: string): StatusDef {
  return defs.find((d) => d.value === value) ?? ALL_STATUS[value] ?? { value, label: value, tone: "cinza" };
}

export const statusLabel = (defs: StatusDef[], value: string) => statusDef(defs, value).label;

export const TONE_CLASS: Record<Tone, string> = {
  cinza: "bg-stone-200 text-stone-700 border-stone-300",
  ambar: "bg-amber-100 text-amber-800 border-amber-300",
  verde: "bg-emerald-100 text-emerald-800 border-emerald-300",
  azul: "bg-sky-100 text-sky-800 border-sky-300",
  roxo: "bg-violet-100 text-violet-800 border-violet-300",
  vermelho: "bg-red-100 text-red-800 border-red-300",
  terracota: "bg-destaque-100 text-destaque-700 border-destaque-300",
};

export const TONE_DOT: Record<Tone, string> = {
  cinza: "bg-stone-400",
  ambar: "bg-amber-500",
  verde: "bg-emerald-500",
  azul: "bg-sky-500",
  roxo: "bg-violet-500",
  vermelho: "bg-red-500",
  terracota: "bg-marca-600",
};

/** Rotulo de pagamento a partir do total e do valor pago. */
export function paymentState(totalCents: number, paidCents: number): StatusDef {
  if (paidCents <= 0 && totalCents > 0) return { value: "pendente", label: "Pendente", tone: "vermelho" };
  if (paidCents >= totalCents) return { value: "pago", label: "Pago", tone: "verde" };
  return { value: "parcial", label: "Parcial", tone: "ambar" };
}
