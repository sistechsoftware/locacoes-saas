/**
 * Programa de fidelidade.
 *
 * Regra inicial: a cada 5 locacoes elegiveis o cliente ganha uma recompensa de
 * ate 5 kits gratis. Nada disso esta fixo aqui: meta, quantidade de kits,
 * validade, acumulo e elegibilidade vem das configuracoes, e mudar a regra
 * amanha nao pode mexer no que ja foi conquistado.
 *
 * Este arquivo nao acessa banco: e a regra, e regra precisa ser testavel
 * sozinha. A recompensa guarda um retrato da regra do dia da conquista, entao o
 * historico se defende sozinho de qualquer alteracao futura.
 */

export type Regra = {
  ativo: boolean;
  /** Locacoes elegiveis para fechar um ciclo. */
  meta: number;
  /** Kits gratuitos concedidos por recompensa. */
  kits: number;
  /** Dias de validade; 0 e "sem validade". */
  validadeDias: number;
  /** Varias metas no mesmo cliente geram varias recompensas? */
  acumular: boolean;
  /** Status de reserva que contam como locacao realizada. */
  statusElegiveis: string[];
  /** Valor minimo da locacao para contar, em centavos. 0 desliga a regra. */
  valorMinimoCents: number;
  /** Locacao que usou recompensa conta para o proximo ciclo? */
  contarLocacaoGratuita: boolean;
};

export const REGRA_PADRAO: Regra = {
  ativo: true,
  meta: 5,
  kits: 5,
  validadeDias: 0,
  acumular: true,
  statusElegiveis: ["retirada", "finalizada"],
  valorMinimoCents: 0,
  contarLocacaoGratuita: false,
};

export type StatusRecompensa = "disponivel" | "usada" | "expirada" | "cancelada";

/** Retrato da regra no momento da conquista, gravado junto com a recompensa. */
export type RegraSnapshot = { meta: number; kits: number; validadeDias: number };

export type Recompensa = {
  id: number;
  customer_id: number;
  status: StatusRecompensa;
  kit_quantity: number;
  earned_at: string;
  expires_on: string | null;
  used_at: string | null;
  used_reservation_id: number | null;
};

/* ------------------------------------------------------------------ */
/* Elegibilidade e progresso                                           */
/* ------------------------------------------------------------------ */

export type Locacao = {
  id: number;
  status: string;
  total_cents: number;
  /** Foi paga com recompensa? */
  usou_recompensa: boolean;
};

/** Esta locacao conta ponto? */
export function elegivel(r: Locacao, regra: Regra): boolean {
  if (!regra.statusElegiveis.includes(r.status)) return false;
  if (regra.valorMinimoCents > 0 && r.total_cents < regra.valorMinimoCents) return false;
  if (r.usou_recompensa && !regra.contarLocacaoGratuita) return false;
  return true;
}

export type Progresso = {
  /** Pontos validos no total, desde sempre. */
  pontos: number;
  /** Quantas metas ja foram fechadas. */
  ciclosCompletos: number;
  /** Posicao dentro do ciclo atual: 4 em "4/5". */
  noCiclo: number;
  /** Quanto falta para fechar o ciclo atual. */
  faltam: number;
  meta: number;
};

export function progresso(pontos: number, regra: Regra): Progresso {
  const meta = Math.max(1, regra.meta);
  const validos = Math.max(0, pontos);
  const ciclosCompletos = Math.floor(validos / meta);
  const noCiclo = validos % meta;
  return {
    pontos: validos,
    ciclosCompletos,
    noCiclo,
    faltam: noCiclo === 0 && validos > 0 ? 0 : meta - noCiclo,
    meta,
  };
}

/**
 * Quantas recompensas o cliente deveria ter, dado o total de pontos.
 *
 * Comparar com o que ja foi emitido e o que torna a geracao idempotente:
 * processar a mesma locacao duas vezes nao gera recompensa a mais, porque a
 * conta parte do saldo, nao do evento.
 */
export function recompensasDevidas(pontos: number, regra: Regra): number {
  const meta = Math.max(1, regra.meta);
  const fechados = Math.floor(Math.max(0, pontos) / meta);
  return regra.acumular ? fechados : Math.min(1, fechados);
}

/** Recompensas a emitir agora: o que e devido menos o que ja existe. */
export function aEmitir(pontos: number, jaEmitidas: number, regra: Regra): number {
  return Math.max(0, recompensasDevidas(pontos, regra) - jaEmitidas);
}

/* ------------------------------------------------------------------ */
/* Validade                                                            */
/* ------------------------------------------------------------------ */

/** Data de expiracao calculada na conquista; null quando nao expira. */
export function expiraEm(dataConquistaISO: string, validadeDias: number): string | null {
  if (!validadeDias || validadeDias <= 0) return null;
  const base = new Date(`${dataConquistaISO.slice(0, 10)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + validadeDias);
  return base.toISOString().slice(0, 10);
}

export function diasAte(dataISO: string | null, hojeISO: string): number | null {
  if (!dataISO) return null;
  const alvo = Date.parse(`${dataISO.slice(0, 10)}T00:00:00Z`);
  const hoje = Date.parse(`${hojeISO.slice(0, 10)}T00:00:00Z`);
  return Math.round((alvo - hoje) / 86400000);
}

/**
 * Situacao real da recompensa hoje.
 *
 * "expirada" e calculada, nao gravada: uma recompensa que venceu ontem ja esta
 * vencida mesmo que nenhuma rotina tenha rodado ainda de madrugada.
 */
export function situacao(r: Pick<Recompensa, "status" | "expires_on">, hojeISO: string): StatusRecompensa {
  if (r.status !== "disponivel") return r.status;
  const dias = diasAte(r.expires_on, hojeISO);
  return dias !== null && dias < 0 ? "expirada" : "disponivel";
}

export const utilizavel = (r: Pick<Recompensa, "status" | "expires_on">, hojeISO: string) =>
  situacao(r, hojeISO) === "disponivel";

/* ------------------------------------------------------------------ */
/* Uso da recompensa                                                   */
/* ------------------------------------------------------------------ */

export type LinhaKit = { product_id: number; qty: number; unit_price_cents: number; kind: string };

export type Beneficio = {
  /** Quantos kits sairam de graca. */
  kitsGratis: number;
  /** Desconto correspondente, em centavos. */
  descontoCents: number;
  /** Detalhe por produto, para registrar o que foi beneficiado. */
  linhas: { product_id: number; qty: number; desconto_cents: number }[];
};

/**
 * Quanto a recompensa cobre desta reserva.
 *
 * So kits entram: frete, forros, mesas e cadeiras avulsas continuam cobrados.
 * O limite e a quantidade de kits da recompensa, e comeca pelos mais caros,
 * que e a leitura generosa para o cliente e a que ele espera.
 */
export function beneficio(itens: LinhaKit[], kitsDaRecompensa: number): Beneficio {
  const kits = itens
    .filter((i) => i.kind === "kit" && i.qty > 0)
    .sort((a, b) => b.unit_price_cents - a.unit_price_cents);

  let restante = Math.max(0, kitsDaRecompensa);
  const linhas: Beneficio["linhas"] = [];
  let desconto = 0;

  for (const linha of kits) {
    if (restante <= 0) break;
    const cobertos = Math.min(restante, linha.qty);
    const valor = cobertos * linha.unit_price_cents;
    if (cobertos > 0) {
      linhas.push({ product_id: linha.product_id, qty: cobertos, desconto_cents: valor });
      desconto += valor;
      restante -= cobertos;
    }
  }

  return { kitsGratis: Math.max(0, kitsDaRecompensa) - restante, descontoCents: desconto, linhas };
}

/* ------------------------------------------------------------------ */
/* Mensagens                                                           */
/* ------------------------------------------------------------------ */

export type EventoFidelidade =
  | "progresso"
  | "quase_la"
  | "conquista"
  | "uso"
  | "vencendo"
  | "expirada"
  | "reversao";

export const EVENTOS: Record<EventoFidelidade, string> = {
  progresso: "Avanço no programa",
  quase_la: "Cliente perto da recompensa",
  conquista: "Recompensa conquistada",
  uso: "Recompensa utilizada",
  vencendo: "Recompensa perto de vencer",
  expirada: "Recompensa expirada",
  reversao: "Pontuação revertida",
};

/**
 * Chave de idempotencia de um aviso.
 *
 * Atingir 4/5 gera um aviso, nao um por vez que alguem abre a tela. A chave
 * inclui o ciclo, entao o mesmo cliente volta a ser avisado no ciclo seguinte.
 */
export function chaveEvento(
  evento: EventoFidelidade,
  customerId: number,
  referencia: number | string,
): string {
  return `fidelidade:${evento}:${customerId}:${referencia}`;
}

/** Variaveis aceitas nos modelos de mensagem, validadas na tela de configuracao. */
export const VARIAVEIS_FIDELIDADE = [
  "cliente_nome",
  "empresa_nome",
  "locacoes_realizadas",
  "locacoes_necessarias",
  "locacoes_restantes",
  "quantidade_kits",
  "data_expiracao",
  "numero_locacao",
  "link",
] as const;

export const MODELOS_PADRAO: Record<EventoFidelidade, string> = {
  progresso:
    "Obrigado pela sua locação, {cliente_nome}! Você já tem {locacoes_realizadas} de {locacoes_necessarias} locações no nosso programa de fidelidade. Faltam {locacoes_restantes} para ganhar até {quantidade_kits} kits grátis.",
  quase_la:
    "Falta apenas {locacoes_restantes} locação para você conquistar até {quantidade_kits} kits grátis, {cliente_nome}! Obrigado por escolher a {empresa_nome}.",
  conquista:
    "Parabéns, {cliente_nome}! Você completou {locacoes_necessarias} locações e conquistou até {quantidade_kits} kits grátis. Fale com a gente para usar na sua próxima locação.",
  uso: "Sua recompensa de fidelidade foi utilizada na locacao {numero_locacao}. Obrigado por continuar escolhendo a {empresa_nome}!",
  vencendo:
    "Você tem uma recompensa de até {quantidade_kits} kits grátis disponível, {cliente_nome}. Ela vale até {data_expiracao}.",
  expirada: "Sua recompensa de até {quantidade_kits} kits grátis expirou em {data_expiracao}.",
  reversao:
    "A locação {numero_locacao} foi cancelada e a pontuação de fidelidade foi ajustada. Qualquer dúvida, fale com a gente.",
};

/** Frase curta do progresso, usada na tela e nos avisos internos. */
export function resumoProgresso(p: Progresso, kits: number): string {
  if (p.faltam === 0 && p.pontos > 0) return `Meta atingida: até ${kits} kits grátis`;
  return p.faltam === 1
    ? `${p.noCiclo}/${p.meta} · falta 1 locação para até ${kits} kits grátis`
    : `${p.noCiclo}/${p.meta} · faltam ${p.faltam} locações para até ${kits} kits grátis`;
}

/** Antecedencias de lembrete, do mais distante ao mais proximo. */
export function lembretesDeVencimento(texto: string): number[] {
  return [...new Set(
    texto
      .split(/[,;\s]+/)
      .map((t) => t.trim())
      .filter((t) => t !== "")
      .map(Number)
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 365),
  )].sort((a, b) => b - a);
}

/**
 * Horario permitido para disparar avisos ao cliente.
 *
 * Fora da janela o aviso espera: ninguem quer receber propaganda as 3 da manha,
 * e mandar assim queima justamente o cliente que o programa quer manter.
 */
export function dentroDaJanela(horaISO: string, inicio: string, fim: string): boolean {
  const hora = horaISO.slice(11, 16);
  if (!/^\d{2}:\d{2}$/.test(inicio) || !/^\d{2}:\d{2}$/.test(fim)) return true;
  return hora >= inicio && hora <= fim;
}
