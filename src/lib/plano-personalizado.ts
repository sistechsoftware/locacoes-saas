import "server-only";
import { all, batch, insert, one, run } from "./db";
import { memoPorInvocacao } from "./perf";
import { nowLocal } from "./format";
import { estadoAssinaturaSeguro } from "./assinatura-gate";
import { logAction } from "./audit";
import type { SessionUser } from "./auth";
import {
  LISTA_RECURSOS,
  RECURSOS,
  ehPlanoValido,
  planoInclui,
  resolverPermissao,
  type AjusteRecurso,
  type OrigemPermissao,
  type PlanoSlug,
  type Recurso,
  type ResolucaoRecurso,
} from "./planos";

/**
 * PERSONALIZAÇÃO POR EMPRESA e CORTESIAS (migration 0039).
 *
 * Camada administrativa do painel /saas que vive POR CIMA da assinatura
 * comercial, sem tocá-la: liberações/bloqueios individuais de funcionalidade,
 * ajuste de limite de usuários e cortesias temporárias. Regras:
 *
 *  * a precedência ÚNICA está em planos.ts (resolverPermissao) — gate,
 *    painel e menu passam todos por ela, então nunca divergem;
 *  * o plano efetivo vem SEMPRE da assinatura gravada no servidor (a mesma
 *    fonte do gate) — nada aqui troca plan_id, price_cents ou período: uma
 *    liberação excepcional nunca vira cobrança nem upgrade automático;
 *  * o benefício da cortesia é DERIVADO DO TEMPO no momento do acesso
 *    (starts_at <= agora <= ends_at, sem cancelamento) — a rotina diária
 *    apenas registra início/término no audit_logs; se ela falhar, a
 *    expiração continua correta porque ninguém depende dela;
 *  * datas são gravadas no fuso do negócio (YYYY-MM-DDTHH:MM, America/
 *    Sao_Paulo — o mesmo formato do nowLocal()), permitindo comparação
 *    lexigrafica direta, sem conversão de fuso;
 *  * toda escrita audita o antes/depois em audit_logs (entidade do ALVO,
 *    entity_id = company_id da empresa afetada) e é atômica via batch D1.
 */

/* -------------------------------------------------------------------------- */
/* Tipos                                                                       */
/* -------------------------------------------------------------------------- */

export type CortesiaLinha = {
  id: number;
  company_id: number;
  plan_slug: string;
  starts_at: string;
  ends_at: string;
  reason: string;
  notes: string | null;
  canceled_at: string | null;
  created_by_name: string | null;
  canceled_by_name: string | null;
  created_at: string;
};

export type EstadoCortesia = "programada" | "ativa" | "expirada" | "cancelada";

/** Estado DERIVADO do tempo — nunca depende de cron ou de coluna de status. */
export function estadoCortesia(
  c: { starts_at: string; ends_at: string; canceled_at?: string | null },
  agora: string = nowLocal(),
): EstadoCortesia {
  if (c.canceled_at) return "cancelada";
  if (agora < normalizarMomento(c.starts_at)) return "programada";
  if (agora > normalizarMomento(c.ends_at)) return "expirada";
  return "ativa";
}

export const ROTULO_ESTADO_CORTESIA: Record<EstadoCortesia, string> = {
  programada: "Programada",
  ativa: "Ativa",
  expirada: "Expirada",
  cancelada: "Cancelada",
};

/** 'YYYY-MM-DDTHH:MM' (aceita com segundos ou com espaço e normaliza). */
const RE_MOMENTO = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/;

export function normalizarMomento(valor: string): string {
  const m = RE_MOMENTO.exec(String(valor ?? "").trim());
  return m ? `${m[1]}T${m[2]}:${m[3]}` : String(valor ?? "").trim();
}

export function momentoValido(valor: unknown): boolean {
  return RE_MOMENTO.test(String(valor ?? "").trim());
}

/** Duração máxima de uma cortesia — evita data absurdamente distante por typo. */
export const MAX_DURACAO_CORTESIA_DIAS = 365;

/* -------------------------------------------------------------------------- */
/* Leitura: ajustes + cortesia vigente + estado efetivo                        */
/* -------------------------------------------------------------------------- */

/** Overrides administrativos permanentes da empresa (feature -> allow/block). */
export async function ajustesDaEmpresa(companyId: number): Promise<Map<Recurso, AjusteRecurso>> {
  const linhas = await all<{ feature: string; effect: string }>(
    `SELECT feature, effect FROM company_feature_overrides WHERE company_id = ?`,
    [companyId],
  );
  const mapa = new Map<Recurso, AjusteRecurso>();
  for (const l of linhas) {
    // Só slugs do catálogo entram na resolução; linha órfã (migração legada)
    // é ignorada em vez de virar comportamento inesperado.
    if ((LISTA_RECURSOS as string[]).includes(l.feature) && (l.effect === "allow" || l.effect === "block")) {
      mapa.set(l.feature as Recurso, l.effect);
    }
  }
  return mapa;
}

/**
 * Cortesia ATIVA da empresa agora (vigente, não cancelada) — a de término
 * mais recente, usada para EXIBIÇÃO no painel.
 * A comparação é lexical no formato local — ver cabeçalho do módulo.
 */
export async function cortesiaAtiva(companyId: number, agora: string = nowLocal()): Promise<CortesiaLinha | null> {
  const linha = await one<CortesiaLinha>(
    `SELECT id, company_id, plan_slug, starts_at, ends_at, reason, notes, canceled_at,
            created_by_name, canceled_by_name, created_at
       FROM company_courtesies
      WHERE company_id = ? AND canceled_at IS NULL
        AND starts_at <= ? AND ends_at >= ?
      ORDER BY ends_at DESC, id DESC LIMIT 1`,
    [companyId, agora, agora],
  );
  return linha ?? null;
}

/**
 * TODAS as cortesias vigentes da empresa — regra de sobreposição documentada:
 * concessões se sobrepõem sem somar períodos; o benefício no instante é a
 * UNIÃO dos planos-referência das cortesias vigentes (uma delas cobrindo o
 * recurso já libera). Cada concessão continua valendo só pela sua janela.
 */
export async function cortesiasAtivas(companyId: number, agora: string = nowLocal()): Promise<CortesiaLinha[]> {
  /* Memo por requisicao (auditoria): o mesmo pedido se repetia em cada porta
     de entrada do mesmo request (estadoRecursosEmpresa + recursoLiberado).
     A chave leva `agora` — quem pede outro instante nao herda resposta alheia. */
  return memoPorInvocacao(`cortesias:${companyId}:${agora}`, () => cortesiasAtivasLeitura(companyId, agora));
}

async function cortesiasAtivasLeitura(companyId: number, agora: string): Promise<CortesiaLinha[]> {
  return await all<CortesiaLinha>(
    `SELECT id, company_id, plan_slug, starts_at, ends_at, reason, notes, canceled_at,
            created_by_name, canceled_by_name, created_at
       FROM company_courtesies
      WHERE company_id = ? AND canceled_at IS NULL
        AND starts_at <= ? AND ends_at >= ?
      ORDER BY ends_at DESC, id DESC`,
    [companyId, agora, agora],
  );
}

/**
 * Estado efetivo de TODOS os recursos da empresa, pela precedência central.
 * É isto que o painel /saas exibe e o que os gates aplicam (um a um).
 */
export async function estadoRecursosEmpresa(companyId: number): Promise<{
  plano: PlanoSlug | null;
  cortesia: (CortesiaLinha & { estado: EstadoCortesia }) | null;
  recursos: { recurso: Recurso; liberado: boolean; origem: OrigemPermissao }[];
}> {
  const [estado, ajustes, ativas] = await Promise.all([
    estadoAssinaturaSeguro(companyId),
    ajustesDaEmpresa(companyId),
    cortesiasAtivas(companyId),
  ]);
  const slug = typeof estado?.plano?.slug === "string" ? (estado.plano.slug as PlanoSlug) : null;
  // Sobreposição: união dos planos-referência vigentes (nenhum reduz outro).
  const slugsCortesia = ativas.map((c) => c.plan_slug).filter(ehPlanoValido);

  const recursos = LISTA_RECURSOS.map((recurso) => {
    const r: ResolucaoRecurso = resolverPermissao({
      recurso,
      ajuste: ajustes.get(recurso) ?? null,
      planoInclui: planoInclui(slug, recurso),
      cortesiaInclui: slugsCortesia.some((s) => planoInclui(s, recurso)),
    });
    return { recurso, liberado: r.liberado, origem: r.origem };
  });

  return {
    plano: slug,
    // Exibição no painel: a vigente de término mais recente (todas ficam na
    // listagem da seção C).
    cortesia: ativas[0] ? { ...ativas[0], estado: estadoCortesia(ativas[0]) } : null,
    recursos,
  };
}

/**
 * Um recurso está liberado para a empresa AGORA? É a consulta usada pelo gate
 * (plano-gate.temprecurso) — mesma precedência do painel e do menu.
 *
 * Leitura fresca (igual ao gate de assinatura): suspender/liberar tem efeito
 * imediato, sem cache velho. O caminho de recurso FUNDAMENTAL faz uma única
 * consulta (os ajustes — que podem bloquear até o fundamental); os pagos
 * consultam assinatura e, se necessário, a cortesia vigente.
 */
export async function recursoLiberado(companyId: number, recurso: Recurso): Promise<boolean> {
  const ajustes = await ajustesDaEmpresa(companyId);
  const ajuste = ajustes.get(recurso) ?? null;
  if (ajuste === "block") return false;
  if (RECURSOS[recurso].fundamental) return true;

  const estado = await estadoAssinaturaSeguro(companyId);
  const slug = typeof estado?.plano?.slug === "string" ? (estado.plano.slug as PlanoSlug) : null;
  if (planoInclui(slug, recurso)) return true;
  if (ajuste === "allow") return true;

  // Sobreposição: qualquer cortesia vigente que cubra o recurso já libera.
  const ativas = await cortesiasAtivas(companyId);
  return ativas.some((c) => ehPlanoValido(c.plan_slug) && planoInclui(c.plan_slug, recurso));
}

/**
 * Conjunto de recursos extras/bloqueados para o FILTRO DO MENU (apresentação).
 * O gate do backend continua decidindo sozinho; isto só evita mostrar item
 * que a porta vai barrar.
 */
export async function ajustesMenuDaEmpresa(
  companyId: number,
): Promise<{ extras: Recurso[]; bloqueados: Recurso[] }> {
  const estado = await estadoRecursosEmpresa(companyId);
  const extras: Recurso[] = [];
  const bloqueados: Recurso[] = [];
  for (const r of estado.recursos) {
    if (r.origem === "bloqueio_admin") bloqueados.push(r.recurso);
    else if (r.liberado && r.origem !== "plano" && r.origem !== "fundamental") extras.push(r.recurso);
  }
  return { extras, bloqueados };
}

/* -------------------------------------------------------------------------- */
/* Escrita: ajustes de funcionalidade                                          */
/* -------------------------------------------------------------------------- */

export type EntradaAjuste = { recurso: string; efeito: "auto" | "liberar" | "bloquear" };

export type ResultadoAdmin =
  | { ok: true; mensagem: string; mudancas: number }
  | { ok: false; erro: string };

function momentoAgora(): string {
  return nowLocal().replace("T", " ");
}

/**
 * Aplica um LOTE de ajustes de funcionalidade para uma empresa.
 *
 * 'auto' remove a linha (volta à regra do plano); 'liberar'/'bloquear' gravam
 * (upsert idempotente pelo UNIQUE company_id+feature). Várias alterações numa
 * única operação atômica (batch D1) e um ÚNICO registro de auditoria com o
 * antes/depois — cliques repetidos não duplicam efeito.
 */
export async function aplicarAjustesRecursos(
  admin: SessionUser,
  companyId: number,
  entradas: EntradaAjuste[],
  motivo: string,
): Promise<ResultadoAdmin> {
  if (!Number.isInteger(companyId) || companyId <= 0) return { ok: false, erro: "Empresa inválida." };
  const empresa = await one<{ id: number; name: string }>(`SELECT id, name FROM companies WHERE id = ?`, [companyId]);
  if (!empresa) return { ok: false, erro: "Empresa inexistente." };

  if (!Array.isArray(entradas) || entradas.length === 0) return { ok: false, erro: "Nenhuma funcionalidade informada." };
  if (entradas.length > LISTA_RECURSOS.length) return { ok: false, erro: "Lote grande demais." };
  for (const e of entradas) {
    if (!(LISTA_RECURSOS as string[]).includes(String(e?.recurso))) {
      return { ok: false, erro: `Funcionalidade desconhecida: ${String(e?.recurso).slice(0, 40)}` };
    }
    if (e.efeito !== "auto" && e.efeito !== "liberar" && e.efeito !== "bloquear") {
      return { ok: false, erro: "Efeito inválido (use auto, liberar ou bloquear)." };
    }
  }

  const motivoLimpo = String(motivo ?? "").trim().slice(0, 300);

  // Antes: estado atual dos recursos afetados (para o auditoria-antes).
  const antes = await ajustesDaEmpresa(companyId);
  const alvos = [...new Set(entradas.map((e) => e.recurso as Recurso))];

  const stmts: { sql: string; params?: any[] }[] = [];
  for (const e of entradas) {
    if (e.efeito === "auto") {
      stmts.push({
        sql: `DELETE FROM company_feature_overrides WHERE company_id = ? AND feature = ?`,
        params: [companyId, e.recurso],
      });
    } else {
      stmts.push({
        sql: `INSERT INTO company_feature_overrides (company_id, feature, effect, reason, created_by, created_by_name)
                VALUES (?,?,?,?,?,?)
              ON CONFLICT(company_id, feature) DO UPDATE SET
                effect = excluded.effect, reason = excluded.reason,
                created_by = excluded.created_by, created_by_name = excluded.created_by_name,
                updated_at = datetime('now','localtime')`,
        params: [companyId, e.recurso, e.efeito === "liberar" ? "allow" : "block", motivoLimpo || null, admin.id, admin.name],
      });
    }
  }
  await batch(stmts);

  const depois = await ajustesDaEmpresa(companyId);
  const mudancas = alvos.filter((r) => (antes.get(r) ?? null) !== (depois.get(r) ?? null)).length;

  await logAction(
    admin,
    "plataforma.recursos_ajustados",
    "company",
    companyId,
    `Funcionalidades da empresa ${empresa.name} ajustadas (${mudancas} mudança${mudancas === 1 ? "" : "s"})`,
    {
      motivo: motivoLimpo || null,
      antes: Object.fromEntries(alvos.map((r) => [r, antes.get(r) ?? "auto"])),
      depois: Object.fromEntries(alvos.map((r) => [r, depois.get(r) ?? "auto"])),
    },
  );

  return {
    ok: true,
    mensagem: mudancas === 0 ? "Nenhuma alteração a aplicar (estava como já configurado)." : `${mudancas} funcionalidade${mudancas === 1 ? "" : "s"} ajustada${mudancas === 1 ? "" : "s"}.`,
    mudancas,
  };
}

/* -------------------------------------------------------------------------- */
/* Escrita: limite de usuários individual                                      */
/* -------------------------------------------------------------------------- */

/**
 * Ajusta (ou remove, com null) o limite de usuários da empresa.
 * A assinatura e o plano continuam intactos — isto é uma exceção auditada.
 */
export async function aplicarLimiteUsuarios(
  admin: SessionUser,
  companyId: number,
  maxUsers: number | null,
  motivo: string,
): Promise<ResultadoAdmin> {
  const empresa = await one<{ id: number; name: string }>(`SELECT id, name FROM companies WHERE id = ?`, [companyId]);
  if (!empresa) return { ok: false, erro: "Empresa inexistente." };

  const antes = await one<{ max_users: number }>(
    `SELECT max_users FROM company_limit_overrides WHERE company_id = ?`,
    [companyId],
  );

  if (maxUsers === null) {
    await run(`DELETE FROM company_limit_overrides WHERE company_id = ?`, [companyId]);
  } else {
    if (!Number.isInteger(maxUsers) || maxUsers < 1 || maxUsers > 500) {
      return { ok: false, erro: "Limite deve ser um número inteiro entre 1 e 500." };
    }
    await run(
      `INSERT INTO company_limit_overrides (company_id, max_users, reason, created_by, created_by_name)
        VALUES (?,?,?,?,?)
       ON CONFLICT(company_id) DO UPDATE SET
         max_users = excluded.max_users, reason = excluded.reason,
         created_by = excluded.created_by, created_by_name = excluded.created_by_name,
         updated_at = datetime('now','localtime')`,
      [companyId, maxUsers, String(motivo ?? "").trim().slice(0, 300) || null, admin.id, admin.name],
    );
  }

  await logAction(
    admin,
    "plataforma.limite_usuarios_ajustado",
    "company",
    companyId,
    `Limite de usuários da empresa ${empresa.name}: ${antes?.max_users ?? "plano"} -> ${maxUsers ?? "plano"}`,
    { motivo: String(motivo ?? "").trim().slice(0, 300) || null, antes: antes?.max_users ?? null, depois: maxUsers },
  );
  return { ok: true, mensagem: maxUsers === null ? "Limite voltou ao do plano." : `Limite definido em ${maxUsers} usuários.`, mudancas: 1 };
}

/* -------------------------------------------------------------------------- */
/* Escrita: cortesias                                                          */
/* -------------------------------------------------------------------------- */

export type EntradaCortesia = {
  planSlug: string;
  startsAt: string;
  endsAt: string;
  motivo: string;
  observacoes?: string;
};

/**
 * Concede uma cortesia. NÃO toca na assinatura, no plano contratado, no
 * preço, em cobranças ou pagamentos — é um registro independente com vigência
 * própria. Idempotência: uma concessão idêntica (empresa + plano + janela)
 * ainda não cancelada devolve a existente em vez de duplicar (duplo clique).
 */
export async function criarCortesia(
  admin: SessionUser,
  companyId: number,
  entrada: EntradaCortesia,
): Promise<ResultadoAdmin & { cortesiaId?: number }> {
  if (!Number.isInteger(companyId) || companyId <= 0) return { ok: false, erro: "Empresa inválida." };
  const empresa = await one<{ id: number; name: string }>(`SELECT id, name FROM companies WHERE id = ?`, [companyId]);
  if (!empresa) return { ok: false, erro: "Empresa inexistente." };

  if (!ehPlanoValido(entrada.planSlug)) return { ok: false, erro: "Plano de referência inválido." };
  const plano = await one<{ id: number; active: number }>(`SELECT id, active FROM plans WHERE slug = ?`, [entrada.planSlug]);
  if (!plano || !plano.active) return { ok: false, erro: "Plano de referência inexistente ou inativo." };

  if (!momentoValido(entrada.startsAt) || !momentoValido(entrada.endsAt)) {
    return { ok: false, erro: "Data e hora de início e término são obrigatórias (formato válido)." };
  }
  const startsAt = normalizarMomento(entrada.startsAt);
  const endsAt = normalizarMomento(entrada.endsAt);
  if (endsAt <= startsAt) return { ok: false, erro: "O término deve ser DEPOIS do início." };

  const duracaoMs = Date.parse(endsAt) - Date.parse(startsAt);
  if (!Number.isFinite(duracaoMs)) return { ok: false, erro: "Datas inconsistentes." };
  if (duracaoMs > MAX_DURACAO_CORTESIA_DIAS * 86400000) {
    return { ok: false, erro: `Duração máxima de uma cortesia é de ${MAX_DURACAO_CORTESIA_DIAS} dias.` };
  }

  const motivo = String(entrada.motivo ?? "").trim();
  if (motivo.length < 3) return { ok: false, erro: "Informe o motivo da concessão (mínimo 3 caracteres)." };

  // Idempotência: concessão idêntica ainda vigente/programada = a mesma.
  const existente = await one<{ id: number }>(
    `SELECT id FROM company_courtesies
      WHERE company_id = ? AND plan_slug = ? AND starts_at = ? AND ends_at = ? AND canceled_at IS NULL
      LIMIT 1`,
    [companyId, entrada.planSlug, startsAt, endsAt],
  );
  if (existente) {
    return { ok: true, mensagem: "Concessão idêntica já registrada (não duplicada).", mudancas: 0, cortesiaId: existente.id };
  }

  const id = await insert(
    `INSERT INTO company_courtesies (company_id, plan_slug, starts_at, ends_at, reason, notes, created_by, created_by_name)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      companyId,
      entrada.planSlug,
      startsAt,
      endsAt,
      motivo.slice(0, 300),
      String(entrada.observacoes ?? "").trim().slice(0, 500) || null,
      admin.id,
      admin.name,
    ],
  );

  await logAction(
    admin,
    "plataforma.cortesia_criada",
    "company",
    companyId,
    `Cortesia concedida à empresa ${empresa.name}: plano ${entrada.planSlug} de ${startsAt.replace("T", " ")} até ${endsAt.replace("T", " ")}`,
    {
      cortesia_id: id,
      plan_slug: entrada.planSlug,
      starts_at: startsAt,
      ends_at: endsAt,
      motivo,
      observacoes: String(entrada.observacoes ?? "").trim().slice(0, 500) || null,
    },
  );

  return {
    ok: true,
    mensagem: estadoCortesia({ starts_at: startsAt, ends_at: endsAt }) === "programada"
      ? "Cortesia agendada: os benefícios entram vigentes na data de início."
      : "Cortesia ativa a partir de agora.",
    mudancas: 1,
    cortesiaId: id,
  };
}

/**
 * Cancela UMA cortesia antecipadamente. Encerra apenas os benefícios daquela
 * concessão: outras cortesias, os ajustes administrativos e a assinatura
 * comercial ficam intactos. O registro histórico é preservado (não é apagado).
 */
export async function cancelarCortesia(
  admin: SessionUser,
  cortesiaId: number,
): Promise<ResultadoAdmin> {
  if (!Number.isInteger(cortesiaId) || cortesiaId <= 0) return { ok: false, erro: "Cortesia inválida." };
  const c = await one<CortesiaLinha>(
    `SELECT id, company_id, plan_slug, starts_at, ends_at, reason, notes, canceled_at,
            created_by_name, canceled_by_name, created_at
       FROM company_courtesies WHERE id = ?`,
    [cortesiaId],
  );
  if (!c) return { ok: false, erro: "Cortesia inexistente." };
  if (c.canceled_at) return { ok: true, mensagem: "Cortesia já estava cancelada.", mudancas: 0 };

  const empresa = await one<{ name: string }>(`SELECT name FROM companies WHERE id = ?`, [c.company_id]);
  await run(
    `UPDATE company_courtesies
        SET canceled_at = ?, canceled_by = ?, canceled_by_name = ?, updated_at = datetime('now','localtime')
      WHERE id = ? AND canceled_at IS NULL`,
    [momentoAgora(), admin.id, admin.name, cortesiaId],
  );

  await logAction(
    admin,
    "plataforma.cortesia_cancelada",
    "company",
    c.company_id,
    `Cortesia #${cortesiaId} da empresa ${empresa?.name ?? c.company_id} cancelada antecipadamente`,
    { cortesia_id: cortesiaId, plan_slug: c.plan_slug, starts_at: c.starts_at, ends_at: c.ends_at },
  );
  return { ok: true, mensagem: "Cortesia cancelada. A assinatura comercial não foi alterada.", mudancas: 1 };
}

/** Histórico de cortesias de uma empresa (mais recentes primeiro). */
export async function listarCortesias(companyId: number): Promise<(CortesiaLinha & { estado: EstadoCortesia })[]> {
  const linhas = await all<CortesiaLinha>(
    `SELECT id, company_id, plan_slug, starts_at, ends_at, reason, notes, canceled_at,
            created_by_name, canceled_by_name, created_at
       FROM company_courtesies WHERE company_id = ? ORDER BY starts_at DESC, id DESC LIMIT 50`,
    [companyId],
  );
  const agora = nowLocal();
  return linhas.map((l) => ({ ...l, estado: estadoCortesia(l, agora) }));
}

/* -------------------------------------------------------------------------- */
/* Rotina diária: registrar início e término das cortesias no audit_logs       */
/* -------------------------------------------------------------------------- */

export type RotinaCortesiasResultado = { iniciadas: number; encerradas: number };

/**
 * Auxiliar do cron: registra no audit_logs o início e o término das cortesias
 * (rastreabilidade pedida no painel). NÃO decide acesso: a vigência é sempre
 * derivada do tempo no momento da autorização, então uma falha desta rotina
 * nunca mantém benefício expirado vivo nem derruba cortesia ativa.
 */
export async function rotinaCortesias(agora: string = nowLocal()): Promise<RotinaCortesiasResultado> {
  const r: RotinaCortesiasResultado = { iniciadas: 0, encerradas: 0 };
  // As colunas starts_at/ends_at são gravadas no formato local COM 'T'
  // (normalizarMomento) — a comparação usa o mesmo formato, senão a ordem
  // lexográfica diverge ('T' > ' ') e a rotina nunca casaria no mesmo dia.
  const agoraISO = normalizarMomento(agora);

  const aIniciar = await all<{ id: number; company_id: number; plan_slug: string; starts_at: string; ends_at: string }>(
    `SELECT id, company_id, plan_slug, starts_at, ends_at FROM company_courtesies
      WHERE canceled_at IS NULL AND inicio_registrado_em IS NULL AND starts_at <= ?`,
    [agoraISO],
  );
  for (const c of aIniciar) {
    await run(`UPDATE company_courtesies SET inicio_registrado_em = ? WHERE id = ?`, [agoraISO, c.id]);
    await logAction(
      null,
      "plataforma.cortesia_iniciada",
      "company",
      c.company_id,
      `Cortesia #${c.id} entrou em vigência (plano ${c.plan_slug})`,
      { cortesia_id: c.id, plan_slug: c.plan_slug, starts_at: c.starts_at, ends_at: c.ends_at },
    );
    r.iniciadas++;
  }

  const aEncerrar = await all<{ id: number; company_id: number; plan_slug: string; starts_at: string; ends_at: string }>(
    `SELECT id, company_id, plan_slug, starts_at, ends_at FROM company_courtesies
      WHERE canceled_at IS NULL AND fim_registrado_em IS NULL AND ends_at < ?`,
    [agoraISO],
  );
  for (const c of aEncerrar) {
    await run(`UPDATE company_courtesies SET fim_registrado_em = ? WHERE id = ?`, [agoraISO, c.id]);
    await logAction(
      null,
      "plataforma.cortesia_encerrada",
      "company",
      c.company_id,
      `Cortesia #${c.id} expirou (plano ${c.plan_slug}) — acessos voltaram às condições comerciais vigentes`,
      { cortesia_id: c.id, plan_slug: c.plan_slug, starts_at: c.starts_at, ends_at: c.ends_at },
    );
    r.encerradas++;
  }

  return r;
}
