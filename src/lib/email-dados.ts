/**
 * Carregamento dos dados que entram nos e-mails — camada SERVER com verificação
 * de integridade multi-tenant.
 *
 * Regra central: a AUTORIDADE do tenant é o registro de origem (reserva,
 * operação, cliente, recompensa), nunca a sessão de quem acionou o processo.
 * Toda leitura abaixo recebe o company_id da ORIGEM e confere, uma a uma, as
 * ligações:
 *
 *   reserva.company_id  == companyId
 *   cliente.company_id  == reserva.company_id
 *   operacao.company_id == companyId
 *   operacao.reservation_id -> reserva da MESMA empresa
 *   recompensa/cliente      -> da MESMA empresa
 *
 * Qualquer divergência devolve `inconsistente: true` e NENHUM dado: quem chama
 * registra o erro de integridade e não envia (nada de "mandar a reserva certa
 * no endereço errado" ou misturar identidade de outro tenant).
 */
import "server-only";
import { all, one } from "./db";
import { settingsDaEmpresa, type Settings } from "./settings";
import { resolverOperacao, type OperacaoConfig } from "./operacao";
import { RESERVATION_STATUS, statusDef } from "./domain";
import { dateBR, timeBR, dateTimeBR } from "./format";
import { publicUrlDaPlataforma } from "./email";
import { emailValido, normalizarEmail } from "./identidade";
import { esc } from "./contract-html";
import { progresso, resolverUnidade, quantidadeUnidade, type Regra } from "./fidelidade";
import type { FidelidadeEmail, IdentidadeEmail, ItemEmail, OperacaoEmail, ReservaEmail } from "./email-templates";

export type Resultado<T> = { ok: true; dados: T } | { ok: false; motivo: MotivoIntegridade | "nao_encontrado" };

export type MotivoIntegridade =
  | "reserva_de_outro_tenant"
  | "cliente_de_outro_tenant"
  | "operacao_de_outro_tenant"
  | "operacao_sem_reserva_valida"
  | "recompensa_de_outro_tenant";

/* ------------------------------------------------------------------ */
/* Identidade da locadora                                              */
/* ------------------------------------------------------------------ */

/**
 * Identidade comercial da EMPRESA dona do evento. `company_name` é o dado
 * cadastrado na tela de Configurações > Empresa; o fallback é o nome do
 * cadastro `companies` (onboarding) e, no fim, um rótulo neutro — nunca o
 * nome de outra locadora e nunca a plataforma no lugar da locadora.
 */
export async function identidadeDaEmpresa(companyId: number): Promise<IdentidadeEmail> {
  const s: Settings = await settingsDaEmpresa(companyId);
  const cadastro = await one<{ name: string }>(`SELECT name FROM companies WHERE id = ?`, [companyId]);
  const nome = String(s.company_name ?? "").trim() || String(cadastro?.name ?? "").trim() || "Locadora";
  return {
    nome,
    logo: String(s.company_logo ?? "").trim() || null,
    telefone: String(s.company_phone ?? "").trim(),
    whatsapp: String(s.company_whatsapp ?? "").trim(),
    endereco: [s.company_address].map((v) => String(v ?? "").trim()).filter(Boolean).join(", "),
    cidade: String(s.company_city ?? "").trim(),
    email: String(s.company_email ?? "").trim(),
    cor: /^#[0-9a-fA-F]{6}$/.test(String(s.email_cor ?? "").trim()) ? String(s.email_cor).trim() : "#C94F00",
    instrucoes: String(s.email_instrucoes ?? "").trim(),
    baseUrl: (await publicUrlDaPlataforma()).trim(),
  };
}

export async function operacaoConfigDaEmpresa(companyId: number): Promise<OperacaoConfig> {
  return resolverOperacao(await settingsDaEmpresa(companyId));
}

/* ------------------------------------------------------------------ */
/* Reserva                                                             */
/* ------------------------------------------------------------------ */

type ReservaRow = {
  id: number;
  number: string;
  company_id: number;
  customer_id: number;
  status: string;
  event_date: string;
  event_time: string | null;
  delivery_at: string | null;
  pickup_at: string | null;
  address: string | null;
  city: string | null;
  cancel_reason: string | null;
  customer_name: string | null;
  customer_company_id: number | null;
  customer_email: string | null;
};

const SELECT_RESERVA = `
  SELECT r.id, r.number, r.company_id, r.customer_id, r.status, r.event_date, r.event_time,
         r.delivery_at, r.pickup_at, r.address, r.city, r.cancel_reason,
         c.name AS customer_name, c.company_id AS customer_company_id, c.email AS customer_email
    FROM reservations r
    LEFT JOIN customers c ON c.id = r.customer_id
   WHERE r.id = ?`;

export type ContextoReserva = {
  linha: ReservaRow;
  cliente: string;
  email: string | null;
};

/**
 * Lê a reserva e confere o encaixe de tenant. Divergência = motivo explícito,
 * sem dados — o chamador registra o erro e não agenda/envia nada.
 */
export async function reservaParaEmail(companyId: number, reservationId: number): Promise<Resultado<ContextoReserva>> {
  const r = await one<ReservaRow>(SELECT_RESERVA, [reservationId]);
  if (!r) return { ok: false, motivo: "nao_encontrado" };
  if (r.company_id !== companyId) return { ok: false, motivo: "reserva_de_outro_tenant" };
  if (r.customer_company_id !== null && r.customer_company_id !== r.company_id) {
    return { ok: false, motivo: "cliente_de_outro_tenant" };
  }
  const email = normalizarEmail(r.customer_email ?? "");
  return {
    ok: true,
    dados: { linha: r, cliente: primeiroNome(r.customer_name), email: emailValido(email) ? email : null },
  };
}

/** E-mail utilizável do cliente da reserva — null quando não há/é inválido. */
export async function emailDoCliente(companyId: number, customerId: number): Promise<{ email: string | null; inconsistente: boolean }> {
  const c = await one<{ company_id: number; email: string | null }>(
    `SELECT company_id, email FROM customers WHERE id = ?`,
    [customerId],
  );
  if (!c) return { email: null, inconsistente: true };
  if (c.company_id !== companyId) return { email: null, inconsistente: true };
  const email = normalizarEmail(c.email ?? "");
  return { email: emailValido(email) ? email : null, inconsistente: false };
}

/**
 * Contexto completo para o template da reserva (com itens e rótulos do perfil).
 * Itens vêm da MESMA empresa (reservation_items.company_id espelha o da reserva).
 */
export async function dadosDaReserva(companyId: number, reservationId: number, cfg: OperacaoConfig): Promise<Resultado<ReservaEmail>> {
  const base = await reservaParaEmail(companyId, reservationId);
  if (!base.ok) return base;
  const r = base.dados.linha;
  const itens = await all<{ name: string; qty: number }>(
    `SELECT p.name, ri.qty FROM reservation_items ri
       JOIN products p ON p.id = ri.product_id
      WHERE ri.reservation_id = ? AND (ri.company_id IS NULL OR ri.company_id = ?)
      ORDER BY ri.id`,
    [reservationId, companyId],
  );
  const defs = RESERVATION_STATUS.map((d) => ({ ...d }));
  const rotuloStatus = defs.find((d) => d.value === r.status)?.label ?? r.status;
  return {
    ok: true,
    dados: {
      cliente: base.dados.cliente,
      numero: r.number,
      dataEvento: dateBR(r.event_date),
      horaEvento: timeBR(r.event_time ?? ""),
      inicio: dateTimeBR(r.delivery_at),
      fim: dateTimeBR(r.pickup_at),
      endereco: [r.address, r.city].filter(Boolean).join(", "),
      itens: itens.map((i) => ({ nome: i.name, qtd: Number(i.qty) || 0 })) as ItemEmail[],
      rotuloInicio: cfg.rotulos.operacao_inicio,
      rotuloFim: cfg.rotulos.operacao_fim,
      status: rotuloStatus,
      motivo: String(r.cancel_reason ?? "").trim(),
      alteracoes: [],
    },
  };
}

/* ------------------------------------------------------------------ */
/* Operação                                                            */
/* ------------------------------------------------------------------ */

type OperacaoRow = {
  id: number;
  company_id: number;
  kind: string;
  status: string;
  scheduled_at: string;
  notes: string | null;
  reservation_id: number | null;
  reservation_company_id: number | null;
  reservation_number: string | null;
  reservation_address: string | null;
  reservation_city: string | null;
  customer_name: string | null;
  customer_company_id: number | null;
  customer_email: string | null;
};

const SELECT_OPERACAO = `
  SELECT o.id, o.company_id, o.kind, o.status, o.scheduled_at, o.notes, o.reservation_id,
         r.company_id AS reservation_company_id, r.number AS reservation_number,
         r.address AS reservation_address, r.city AS reservation_city,
         c.name AS customer_name, c.company_id AS customer_company_id, c.email AS customer_email
    FROM operations o
    LEFT JOIN reservations r ON r.id = o.reservation_id
    LEFT JOIN customers c ON c.id = r.customer_id
   WHERE o.id = ?`;

export type ContextoOperacao = {
  linha: OperacaoRow;
  cliente: string;
  email: string | null;
  rotulo: string;
};

/**
 * Lê a operação com reserva e cliente, conferindo cada ligação de tenant.
 * Operação sem reserva ou com reserva de outra empresa = inconsistência.
 */
export async function operacaoParaEmail(
  companyId: number,
  operationId: number,
  cfg: OperacaoConfig,
): Promise<Resultado<ContextoOperacao>> {
  const o = await one<OperacaoRow>(SELECT_OPERACAO, [operationId]);
  if (!o) return { ok: false, motivo: "nao_encontrado" };
  if (o.company_id !== companyId) return { ok: false, motivo: "operacao_de_outro_tenant" };
  if (!o.reservation_id || o.reservation_company_id !== companyId) return { ok: false, motivo: "operacao_sem_reserva_valida" };
  if (o.customer_company_id !== null && o.customer_company_id !== companyId) {
    return { ok: false, motivo: "cliente_de_outro_tenant" };
  }
  const email = normalizarEmail(o.customer_email ?? "");
  const rotulo =
    o.kind === "entrega" ? cfg.rotulos.operacao_inicio : o.kind === "retirada" ? cfg.rotulos.operacao_fim : capitalizar(o.kind);
  return {
    ok: true,
    dados: { linha: o, cliente: primeiroNome(o.customer_name), email: emailValido(email) ? email : null, rotulo },
  };
}

export async function dadosDaOperacao(companyId: number, operationId: number, cfg: OperacaoConfig): Promise<Resultado<OperacaoEmail>> {
  const base = await operacaoParaEmail(companyId, operationId, cfg);
  if (!base.ok) return base;
  const o = base.dados.linha;
  return {
    ok: true,
    dados: {
      cliente: base.dados.cliente,
      numero: String(o.reservation_number ?? "-"),
      tipo: base.dados.rotulo,
      quando: dateTimeBR(o.scheduled_at),
      endereco: [o.reservation_address, o.reservation_city].filter(Boolean).join(", "),
      status: statusOperacao(o.status),
      obs: String(o.notes ?? "").trim().slice(0, 300),
    },
  };
}

export function statusOperacao(status: string): string {
  const mapa: Record<string, string> = {
    pendente: "Pendente",
    confirmada: "Confirmada",
    em_rota: "Em rota",
    no_local: "No local",
    concluida: "Concluída",
    reagendada: "Reagendada",
    cancelada: "Cancelada",
  };
  return mapa[status] ?? status;
}

/* ------------------------------------------------------------------ */
/* Fidelidade                                                          */
/* ------------------------------------------------------------------ */

/**
 * Contexto de fidelidade com verificação de tenant.
 *
 * A autoridade é o CLIENTE (customers.company_id) ou a RECOMPENSA
 * (fidelity_rewards.company_id) — o evento nasceu lá, não na sessão.
 */
export async function dadosDeFidelidade(
  companyId: number,
  customerId: number,
  extras: { rewardId?: number | null } = {},
): Promise<Resultado<FidelidadeEmail>> {
  const c = await one<{ id: number; company_id: number; name: string | null }>(
    `SELECT id, company_id, name FROM customers WHERE id = ?`,
    [customerId],
  );
  if (!c) return { ok: false, motivo: "nao_encontrado" };
  if (c.company_id !== companyId) return { ok: false, motivo: "recompensa_de_outro_tenant" };

  if (extras.rewardId) {
    const rw = await one<{ company_id: number }>(`SELECT company_id FROM fidelity_rewards WHERE id = ?`, [extras.rewardId]);
    if (!rw) return { ok: false, motivo: "nao_encontrado" };
    if (rw.company_id !== companyId) return { ok: false, motivo: "recompensa_de_outro_tenant" };
  }

  const s = await settingsDaEmpresa(companyId);
  const cfg = resolverOperacao(s);
  const unidade = resolverUnidade(String(s.fidelity_unidade ?? ""), cfg.perfil);
  const regra: Regra = {
    ativo: s.fidelity_active !== "0",
    meta: Math.max(1, Number(s.fidelity_goal) || 5),
    kits: Math.max(0, Number(s.fidelity_kits) || 0),
    validadeDias: Math.max(0, Number(s.fidelity_validity_days) || 0),
    acumular: s.fidelity_accumulate !== "0",
    statusElegiveis: [],
    valorMinimoCents: 0,
    contarLocacaoGratuita: false,
    perfil: cfg.perfil,
    unidade,
  };
  const pontos = await one<{ n: number }>(`SELECT COALESCE(SUM(delta),0) AS n FROM fidelity_events WHERE customer_id = ?`, [customerId]);
  // mesma conta do modulo de fidelidade: nenhuma contagem paralela
  const p = progresso(Number(pontos?.n ?? 0), regra);

  return {
    ok: true,
    dados: {
      cliente: primeiroNome(c.name),
      atual: p.pontos,
      meta: p.meta,
      faltam: p.faltam,
      unidade: unidade.plural,
      unidadeSingular: unidade.singular,
      beneficio: `${quantidadeUnidade(regra.kits, unidade)} grátis`,
      quando: "",
      condicoes: condicoesDoBeneficio(s),
    },
  };
}

/** Condições de uso SÓ se a empresa as cadastrou — nada de prazo inventado. */
function condicoesDoBeneficio(s: Settings): string[] {
  const dias = Number(s.fidelity_validity_days) || 0;
  const condicoes: string[] = [];
  if (dias > 0) condicoes.push(`validade de ${dias} dias a partir da conquista`);
  if (s.fidelity_accumulate === "0") condicoes.push("não acumula com outras recompensas");
  return condicoes;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function primeiroNome(nome: string | null | undefined): string {
  const n = String(nome ?? "").trim();
  return n ? esc(n.split(" ")[0]) : "cliente";
}

function capitalizar(v: string): string {
  return v ? v[0].toUpperCase() + v.slice(1) : v;
}

/**
 * Descrição das mudanças de uma reserva, para o aviso de alteração.
 * Comparação feita no servidor entre a linha anterior e a nova; valores vazios
 * saem da lista (nada de "mudou para vazio").
 */
export function descreverAlteracoesReserva(
  anterior: Record<string, unknown>,
  nova: Record<string, unknown>,
  cfg: OperacaoConfig,
): string[] {
  const mudou = (chave: string, rotulo: string): string | null => {
    const a = String(anterior[chave] ?? "");
    const b = String(nova[chave] ?? "");
    if (a === b) return null;
    if (!b) return null;
    return `${rotulo}: ${formatar(chave, a)} → ${formatar(chave, b)}`;
  };
  const lista = [
    mudou("event_date", cfg.vis.evento ? cfg.rotulos.evento : "Início da locação"),
    mudou("event_time", cfg.rotulos.evento_hora),
    mudou("delivery_at", cfg.rotulos.inicio),
    mudou("pickup_at", cfg.rotulos.fim),
    nova["status"] !== anterior["status"] ? `Status: ${statusReservaLabel(String(anterior["status"]))} → ${statusReservaLabel(String(nova["status"]))}` : null,
  ].filter((x): x is string => !!x);
  return lista;
}

function statusReservaLabel(v: string): string {
  return RESERVATION_STATUS.find((d) => d.value === v)?.label ?? statusDef(RESERVATION_STATUS, v).label ?? v;
}

function formatar(chave: string, v: string): string {
  if (!v) return "-";
  if (chave === "event_date") return dateBR(v);
  if (chave === "event_time") return timeBR(v);
  if (chave === "delivery_at" || chave === "pickup_at") return dateTimeBR(v);
  return v;
}
