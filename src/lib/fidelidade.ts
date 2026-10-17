/**
 * Programa de fidelidade.
 *
 * Regra inicial: a cada 5 locacoes elegiveis o cliente ganha uma recompensa de
 * ate 5 kits gratis. Nada disso esta fixo aqui: meta, quantidade de kits, unidade,
 * validade, acumulo e elegibilidade vem das configuracoes, e mudar a regra
 * amanha nao pode mexer no que ja foi conquistado.
 *
 * Este arquivo nao acessa banco: e a regra, e regra precisa ser testavel
 * sozinha. A recompensa guarda um retrato da regra do dia da conquista, entao o
 * historico se defende sozinho de qualquer alteracao futura.
 */

import { pluralizar, type PerfilOperacional } from "./operacao";

/* ------------------------------------------------------------------ */
/* Unidade da recompensa (o que o cliente ganha)                       */
/* ------------------------------------------------------------------ */

/**
 * Nome da unidade da recompensa, no singular e no plural ("kit"/"kits").
 *
 * O sistema nasceu falando "kits" — e esse continua sendo o padrao da
 * plataforma (perfil Festas). O texto de TODA a parte de fidelidade sai daqui:
 * o perfil operacional fornece o padrao (Carretinhas fala "locacao"/
 * "locacoes") e a chave `fidelity_unidade` permite trocar por qualquer outro
 * termo ("vale", "brinde", "diaria/diarias"). Vazio = padrao do perfil;
 * preenchido = a empresa decidiu, e vale em todas as telas.
 */
export type Unidade = { singular: string; plural: string };

export const UNIDADE_PADRAO: Unidade = { singular: "kit", plural: "kits" };

/** Padrao de cada perfil operacional — mesma fonte dos rotulos da operacao. */
export const UNIDADES_PERFIL: Record<PerfilOperacional, Unidade> = {
  festas: { singular: "kit", plural: "kits" },
  carretinhas: { singular: "locação", plural: "locações" },
  /* Personalizado nao tem preset: sem campo preenchido vale o padrao da
     plataforma. Trocar o termo e escolha explicita do administrador. */
  personalizado: UNIDADE_PADRAO,
};

/**
 * Normaliza o texto livre do campo de unidade para gravar.
 * Aceita "kit" (plural derivado) ou "locação/locações" (plural explicito);
 * vazio oulixo = "", que na leitura cai no padrao do perfil.
 */
export function normalizarUnidade(texto: string | null | undefined): string {
  const limpo = String(texto ?? "")
    // caracteres de controle saem por completo (mesma regra dos rótulos de operação)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
  const partes = limpo.split("/").map((p) => p.trim()).filter(Boolean);
  if (!partes.length) return "";
  return partes.slice(0, 2).join("/").slice(0, 60);
}

/** Unidade efetiva: texto gravado da empresa ou padrao do perfil operacional. */
export function resolverUnidade(texto: string | null | undefined, perfil: PerfilOperacional): Unidade {
  const partes = normalizarUnidade(texto)
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (partes[0]) return { singular: partes[0], plural: partes[1] ?? pluralizar(partes[0]) };
  return UNIDADES_PERFIL[perfil];
}

/** "1 kit" / "5 kits" — concordância numérica com a unidade da empresa. */
export function quantidadeUnidade(qtd: number, unidade: Unidade = UNIDADE_PADRAO): string {
  const q = Number.isFinite(qtd) ? qtd : 0;
  return `${q} ${q === 1 ? unidade.singular : unidade.plural}`;
}

/** "Kits grátis" — título do campo de configuração (singular/plural do perfil). */
export function rotuloUnidade(unidade: Unidade = UNIDADE_PADRAO): string {
  const p = unidade.plural;
  return `${p.charAt(0).toUpperCase()}${p.slice(1)} grátis`;
}

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
  /** Perfil operacional da empresa — origem dos textos de fidelidade. */
  perfil: PerfilOperacional;
  /** Unidade da recompensa (singular/plural) usada em todas as telas. */
  unidade: Unidade;
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
  perfil: "festas",
  unidade: { ...UNIDADE_PADRAO },
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

/**
 * Opções do benefício. `cobrirSimples` liga a cobertura de produtos simples
 * (catálogo sem kits, como o de Carretinhas): sem ela, só linhas de kit são
 * descontadas — o padrão histórico de Festas, preservado nos testes.
 */
export type BeneficioOpcoes = { cobrirSimples?: boolean };

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
 * Por padrao so kits entram: frete, forros, mesas e cadeiras avulsas continuam
 * cobrados. Com `cobrirSimples` (perfis fora de Festas), itens simples tambem entram.
 * O limite e a quantidade de kits da recompensa, e comeca pelos mais caros,
 * que e a leitura generosa para o cliente e a que ele espera.
 */
export function beneficio(
  itens: LinhaKit[],
  kitsDaRecompensa: number,
  opts: BeneficioOpcoes = {},
): Beneficio {
  const kits = itens
    .filter((i) => i.qty > 0 && (i.kind === "kit" || (opts.cobrirSimples === true && i.kind !== "kit")))
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
  "unidade",
  "data_expiracao",
  "numero_locacao",
  "link",
] as const;

export const MODELOS_PADRAO: Record<EventoFidelidade, string> = {
  progresso:
    "Obrigado pela sua locação, {cliente_nome}! Você já tem {locacoes_realizadas} de {locacoes_necessarias} locações no nosso programa de fidelidade. Faltam {locacoes_restantes} para ganhar até {quantidade_kits} {unidade} grátis.",
  quase_la:
    "Falta apenas {locacoes_restantes} locação para você conquistar até {quantidade_kits} {unidade} grátis, {cliente_nome}! Obrigado por escolher a {empresa_nome}.",
  conquista:
    "Parabéns, {cliente_nome}! Você completou {locacoes_necessarias} locações e conquistou até {quantidade_kits} {unidade} grátis. Fale com a gente para usar na sua próxima locação.",
  uso: "Sua recompensa de fidelidade foi utilizada na locacao {numero_locacao}. Obrigado por continuar escolhendo a {empresa_nome}!",
  vencendo:
    "Você tem uma recompensa de até {quantidade_kits} {unidade} grátis disponível, {cliente_nome}. Ela vale até {data_expiracao}.",
  expirada: "Sua recompensa de até {quantidade_kits} {unidade} grátis expirou em {data_expiracao}.",
  reversao:
    "A locação {numero_locacao} foi cancelada e a pontuação de fidelidade foi ajustada. Qualquer dúvida, fale com a gente.",
};

/**
 * Modelos ANTES da unidade por perfil — com "kits" literal.
 *
 * Não é o que se envia: serve para reconhecer o que a empresa NUNCA editou.
 * Uma mensagem salva igual a este texto (ou igual ao modelo novo) é padrão e
 * acompanha a unidade vigente; qualquer outra diferença é personalização de
 * verdade e prevalece — a mesma regra dos rótulos de operação.
 */
export const MODELOS_LEGADO: Record<EventoFidelidade, string> = {
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

/**
 * Modelo efetivo de um evento: o que a empresa gravou, ou o padrão quando ela
 * não personalizou (vazio, igual ao modelo novo ou igual ao legado).
 * Usado tanto no envio quanto na pré-visualização em Configurações.
 */
export function modeloFidelidade(evento: EventoFidelidade, salvo: string | null | undefined): string {
  const texto = String(salvo ?? "").trim();
  if (!texto || texto === MODELOS_PADRAO[evento] || texto === MODELOS_LEGADO[evento]) return MODELOS_PADRAO[evento];
  return texto;
}

/**
 * Preenche {chave} (e {{chave}}) de um modelo de mensagem de fidelidade.
 *
 * renderTemplate (settings) só entende chaves DUPLAS, que é a sintaxe dos
 * contratos e das mensagens de WhatsApp gerais — os modelos daqui usam chaves
 * SIMPLES e nunca passaram por ele: a mensagem era gravada com {cliente_nome}
 * literal. Variável vazia/ausente sai vazia, como na regra dos contratos.
 */
export function renderMensagemModelo(
  modelo: string,
  vars: Record<string, string | number | null | undefined>,
): string {
  return modelo.replace(/\{\{\s*(\w+)\s*\}\}|\{(\w+)\}/g, (_m, dupla: string | undefined, simples: string | undefined) => {
    const v = vars[dupla ?? simples ?? ""];
    return v === null || v === undefined || v === "" ? "" : String(v);
  });
}

/** Frase curta do progresso, usada na tela e nos avisos internos. */
export function resumoProgresso(p: Progresso, kits: number, unidade: Unidade = UNIDADE_PADRAO): string {
  const premio = `até ${quantidadeUnidade(kits, unidade)} grátis`;
  if (p.faltam === 0 && p.pontos > 0) return `Meta atingida: ${premio}`;
  return p.faltam === 1
    ? `${p.noCiclo}/${p.meta} · falta 1 locação para ${premio}`
    : `${p.noCiclo}/${p.meta} · faltam ${p.faltam} locações para ${premio}`;
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
