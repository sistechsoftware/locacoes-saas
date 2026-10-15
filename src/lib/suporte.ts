import "server-only";
import { all, insert, one, run, scalar } from "./db";
import { logAction } from "./audit";
import { enviarEmail } from "./email";
import { recursoLiberado } from "./plano-personalizado";
import { planoDaEmpresa } from "./plano-gate";
import { saveChatAttachment, type ChatSavedFile } from "./uploads";
import type { SessionUser } from "./auth";
import type { StatusDef } from "./domain";

/**
 * SUPORTE — chamados da empresa <-> equipe da plataforma.
 *
 * Regras de produto (relatório de implementação do suporte):
 *  * ABERTURA e acompanhamento são FUNDAMENTAIS: todo plano abre e responde
 *    chamados. O canal de atendimento não é item da oferta — o próprio
 *    planos.ts proíbe inventar limitação comercial fora dela;
 *  * "suporte prioritário" (recurso da matriz, minimo = empresarial) é o NÍVEL
 *    DE FILA: a prioridade sai de recursoLiberado(company, "suporte"), nunca
 *    de comparação de slug neste arquivo. O priority gravado na abertura é só
 *    contexto histórico; a fila reordena pelo estado ATUAL (troca de plano,
 *    cortesia e liberação/administrativa valem na hora);
 *  * escopo de tenant sempre pelo company_id lido no servidor (sessão) — a
 *    fila /saas é a única visão global e exige platform_admin;
 *  * notificação reusa a central existente (user_notifications type 'suporte')
 *    + fila de push (push_deliveries) — mesma semântica do chat, com a regra
 *    padrão semeada pela migration 0041 e pelo onboarding (REGRAS_PADRAO);
 *  * e-mail é fail-open (enviarEmail nunca derruba o fluxo; sem RESEND_* o
 *    envio é pulado e a causa fica em /erros).
 */

export type CategoriaChamado = "erro" | "cobranca" | "duvida" | "sugestao";
export type StatusChamado = "aberto" | "em_andamento" | "aguardando_empresa" | "resolvido";
export type PrioridadeChamado = "normal" | "prioritario";
export type LadoChamado = "empresa" | "suporte";

export const CATEGORIAS: { valor: CategoriaChamado; label: string }[] = [
  { valor: "erro", label: "Erro — algo não funcionou" },
  { valor: "cobranca", label: "Cobrança e assinatura" },
  { valor: "duvida", label: "Dúvida / como usar" },
  { valor: "sugestao", label: "Sugestão de melhoria" },
];

export function labelCategoria(valor: string): string {
  return CATEGORIAS.find((c) => c.valor === valor)?.label ?? valor;
}

/** Definições de status para StatusBadge (empresa e plataforma). */
export const STATUS_CHAMADO: StatusDef[] = [
  { value: "aberto", label: "Aberto", tone: "azul" },
  { value: "em_andamento", label: "Em andamento", tone: "ambar" },
  { value: "aguardando_empresa", label: "Aguardando a empresa", tone: "terracota" },
  { value: "resolvido", label: "Resolvido", tone: "verde" },
];

export type Chamado = {
  id: number;
  company_id: number;
  created_by: number;
  category: CategoriaChamado;
  subject: string;
  status: StatusChamado;
  priority: PrioridadeChamado;
  plano_abertura: string | null;
  context: string | null;
  first_response_at: string | null;
  resolved_at: string | null;
  empresa_last_seen_id: number | null;
  plataforma_last_seen_id: number | null;
  created_at: string;
  updated_at: string;
  /** Mensagens do suporte ainda não vistas (lado da empresa). */
  nao_lidas?: number;
  /** Mensagens da empresa ainda não vistas (lado da plataforma). */
  nao_lidas_plataforma?: number;
  /** Preenchido só na fila da plataforma: prioridade AO VIVO da matriz. */
  prioridade_viva?: PrioridadeChamado;
  company_name?: string;
  plan_slug?: string | null;
};

export type MensagemChamado = {
  id: number;
  ticket_id: number;
  company_id: number;
  author_id: number | null;
  author_kind: LadoChamado;
  body: string;
  file_id: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  created_at: string;
  author_name?: string | null;
};

const ASSUNTO_MIN = 4;
const ASSUNTO_MAX = 140;
const CORPO_MAX = 4000;

function limpar(valor: unknown, max: number): string {
  return String(valor ?? "").replace(/\r\n/g, "\n").trim().slice(0, max);
}

/* -------------------------------------------------------------------------- */
/* Prioridade — saída da MATRIZ de planos, nunca de slug gravado               */
/* -------------------------------------------------------------------------- */

/**
 * Nível de fila da empresa: "prioritario" quando o recurso `suporte` está
 * liberado HOJE para a empresa (plano Empresarial, cortesia vigente ou
 * liberação administrativa — precedência central de planos.ts). Falha de
 * leitura não promove: vira "normal".
 */
export async function prioridadeDaEmpresa(companyId: number): Promise<PrioridadeChamado> {
  try {
    return (await recursoLiberado(companyId, "suporte")) ? "prioritario" : "normal";
  } catch {
    return "normal";
  }
}

/* -------------------------------------------------------------------------- */
/* Notificações (central + push) — espelha o caminho do chat                   */
/* -------------------------------------------------------------------------- */

type Destino = { user_id: number; company_id: number };

async function adminsDaPlataforma(): Promise<Destino[]> {
  const rows = await all<{ id: number; company_id: number }>(
    `SELECT id, company_id FROM users WHERE platform_admin = 1 AND active = 1`,
  );
  return rows.map((r) => ({ user_id: r.id, company_id: r.company_id }));
}

async function equipeDaEmpresa(companyId: number): Promise<Destino[]> {
  const rows = await all<{ id: number; company_id: number }>(
    `SELECT id, company_id FROM users WHERE company_id = ? AND active = 1 AND role IN ('owner','admin')`,
    [companyId],
  );
  return rows.map((r) => ({ user_id: r.id, company_id: r.company_id }));
}

/**
 * Insere na central (user_notifications) e cria a entrega de push pendente —
 * o cron de 1 minuto envia (mesmo caminho do chat; a regra type 'suporte'
 * existe em toda empresa via migration 0041 + REGRAS_PADRAO do onboarding).
 * Sem dispositivo/VAPID nada quebra: só não há push.
 */
async function notificar(destinos: Destino[], titulo: string, corpo: string, link: string): Promise<void> {
  for (const d of destinos) {
    await run(
      `INSERT INTO user_notifications (user_id, event_id, type, title, body, link, created_at, company_id)
       VALUES (?, NULL, 'suporte', ?, ?, ?, unixepoch(), ?)
       ON CONFLICT(user_id, event_id) DO NOTHING`,
      [d.user_id, titulo.slice(0, 140), corpo.slice(0, 200), link, d.company_id],
    );
    await run(
      `INSERT OR IGNORE INTO push_deliveries (company_id, notification_id, subscription_id)
       SELECT n.company_id, n.id, s.id
         FROM user_notifications n
         JOIN push_subscriptions s ON s.user_id = n.user_id AND s.company_id = n.company_id
        WHERE n.id = (SELECT MAX(id) FROM user_notifications WHERE user_id = ? AND type = 'suporte' AND link = ?)
          AND s.enabled = 1
          AND (s.expiration_time IS NULL OR s.expiration_time > ?)`,
      [d.user_id, link, Date.now()],
    );
  }
}

/* -------------------------------------------------------------------------- */
/* E-mail fail-open (só suporte -> empresa)                                    */
/* -------------------------------------------------------------------------- */

async function baseUrl(): Promise<string> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const host = h.get("x-forwarded-host") || h.get("host") || "";
    const proto = h.get("x-forwarded-proto") || "https";
    return host ? `${proto}://${host}` : "";
  } catch {
    return "";
  }
}

function escapeHtml(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Notifica o autor do chamado que há resposta do suporte. Nunca lança. */
async function emailRespostaSuporte(ticket: Chamado, trecho: string): Promise<void> {
  try {
    const criador = await one<{ email: string | null; name: string }>(
      `SELECT email, name FROM users WHERE id = ?`,
      [ticket.created_by],
    );
    if (!criador?.email) return;
    const base = await baseUrl();
    const link = `${base}/suporte/${ticket.id}`;
    const assunto = escapeHtml(ticket.subject);
    const previa = escapeHtml(trecho.slice(0, 600));
    await enviarEmail({
      to: criador.email,
      subject: `O suporte respondeu o chamado #${ticket.id} — Locô`,
      html: `<p>Olá, ${escapeHtml(criador.name)}.</p>
   <p>A equipe de suporte respondeu ao seu chamado <b>${assunto}</b>:</p>
   <blockquote style="border-left:3px solid #C94F00;padding-left:12px;color:#444;">${previa}</blockquote>
   <p><a href="${link}" style="display:inline-block;background:#C94F00;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;border-radius:12px;padding:12px 20px;">Ver a conversa</a></p>
   <p>Se o botão não abrir, copie e cole no navegador:<br>${link}</p>`,
      text: `O suporte respondeu ao chamado "${ticket.subject}":\n\n${trecho.slice(0, 800)}\n\nVer conversa: ${link}`,
    });
  } catch {
    // fail-open: sem e-mail configurado o fluxo segue (contrato de email.ts)
  }
}

/* -------------------------------------------------------------------------- */
/* Abrir chamado                                                               */
/* -------------------------------------------------------------------------- */

export type EntradaAbertura = {
  categoria: unknown;
  assunto: unknown;
  descricao: unknown;
  arquivo?: File | null;
};

async function gravarAnexo(arquivo: File | null | undefined): Promise<ChatSavedFile | null> {
  if (!arquivo || typeof arquivo === "string" || arquivo.size === 0) return null;
  return await saveChatAttachment(arquivo, { origem: "suporte" });
}

/**
 * Abre um chamado no escopo da empresa do AUTOR (company_id da sessão).
 * A prioridade nasce da matriz; o contexto guarda plano/papel e os erros
 * recentes do Diário de erros da empresa para o diagnóstico.
 */
export async function abrirChamado(autor: SessionUser, dados: EntradaAbertura): Promise<number> {
  const categoria = String(dados.categoria ?? "");
  if (!CATEGORIAS.some((c) => c.valor === categoria)) throw new Error("Escolha uma categoria válida.");
  const assunto = limpar(dados.assunto, ASSUNTO_MAX);
  if (assunto.length < ASSUNTO_MIN) throw new Error(`Informe um assunto com pelo menos ${ASSUNTO_MIN} caracteres.`);
  const descricao = limpar(dados.descricao, CORPO_MAX);
  if (descricao.length < 10) throw new Error("Descreva o problema com pelo menos 10 caracteres.");

  const anexo = await gravarAnexo(dados.arquivo);
  const prioridade = await prioridadeDaEmpresa(autor.company_id);
  const plano = await planoDaEmpresa(autor.company_id);
  const erros = await all<{ id: number; message: string; route: string | null }>(
    `SELECT id, message, route FROM error_logs WHERE company_id = ? ORDER BY id DESC LIMIT 3`,
    [autor.company_id],
  );
  const context = JSON.stringify({
    plano,
    papel: autor.role,
    erros: erros.map((e) => ({ id: e.id, message: e.message.slice(0, 300), route: e.route })),
  });

  const id = await insert(
    `INSERT INTO support_tickets (company_id, created_by, category, subject, status, priority, plano_abertura, context)
     VALUES (?,?,?,?, 'aberto', ?, ?, ?)`,
    [autor.company_id, autor.id, categoria, assunto, prioridade, plano, context],
  );
  await insert(
    `INSERT INTO support_messages (ticket_id, company_id, author_id, author_kind, body, file_id, file_name, file_mime, file_size)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, autor.company_id, autor.id, "empresa", descricao, anexo?.id ?? null, anexo?.name ?? null, anexo?.mime ?? null, anexo?.size ?? null],
  );
  await logAction(autor, "abrir", "suporte", id, `${autor.name} abriu chamado de suporte #${id}: ${assunto}`);
  await notificar(await adminsDaPlataforma(), `Novo chamado de suporte #${id}`, assunto, `/saas/suporte/${id}`);
  return id;
}

/* -------------------------------------------------------------------------- */
/* Leitura — escopo de tenant                                                  */
/* -------------------------------------------------------------------------- */

/** Colunas da lista (com contadores de não lidas dos DOIS lados). */
const COLUNAS_LISTA = `t.*,
    (SELECT COUNT(*) FROM support_messages m
      WHERE m.ticket_id = t.id AND m.author_kind = 'suporte'
        AND m.id > COALESCE(t.empresa_last_seen_id, 0)) AS nao_lidas,
    (SELECT COUNT(*) FROM support_messages m
      WHERE m.ticket_id = t.id AND m.author_kind = 'empresa'
        AND m.id > COALESCE(t.plataforma_last_seen_id, 0)) AS nao_lidas_plataforma`;

const SELECT_LISTA = `SELECT ${COLUNAS_LISTA} FROM support_tickets t`;

/** Chamados da empresa, mais recentes primeiro. Resolvidos só se pedidos. */
export async function listarChamados(
  companyId: number,
  opts: { limite?: number; offset?: number; incluirResolvidos?: boolean } = {},
): Promise<Chamado[]> {
  const where = opts.incluirResolvidos ? "" : "AND t.status <> 'resolvido'";
  return await all<Chamado>(
    `${SELECT_LISTA} WHERE t.company_id = ? ${where} ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`,
    [companyId, opts.limite ?? 60, opts.offset ?? 0],
  );
}

/** Barreira de tenant: chamado de OUTRA empresa é inexistente. */
export async function chamadoDaEmpresa(ticketId: number, companyId: number): Promise<Chamado | null> {
  return (
    (await one<Chamado>(
      `${SELECT_LISTA} WHERE t.id = ? AND t.company_id = ?`,
      [ticketId, companyId],
    )) ?? null
  );
}

/**
 * Chamado qualquer — SOMENTE após confirmar platform_admin no chamador.
 * Já traz nome da empresa e slug do plano (exibição; a autorização/prioridade
 * continua saindo da matriz, nunca do slug).
 */
export async function chamadoDaPlataforma(ticketId: number): Promise<Chamado | null> {
  return (
    (await one<Chamado>(
      `SELECT t.*, c.name AS company_name, pl.slug AS plan_slug
         FROM support_tickets t
         JOIN companies c ON c.id = t.company_id
         LEFT JOIN subscriptions s ON s.company_id = t.company_id
         LEFT JOIN plans pl ON pl.id = s.plan_id
        WHERE t.id = ?`,
      [ticketId],
    )) ?? null
  );
}

export async function mensagensDoChamado(ticketId: number): Promise<MensagemChamado[]> {
  return await all<MensagemChamado>(
    `SELECT m.*, u.name AS author_name
       FROM support_messages m
       LEFT JOIN users u ON u.id = m.author_id
      WHERE m.ticket_id = ?
      ORDER BY m.id ASC`,
    [ticketId],
  );
}

/** Caminho do anexo: vínculo mensagem -> chamado + escopo (empresa ou plat.). */
export async function podeVerAnexoSuporte(fileId: string, user: SessionUser): Promise<boolean> {
  const vinculo = await one<{ ticket_id: number }>(
    `SELECT ticket_id FROM support_messages WHERE file_id = ? LIMIT 1`,
    [fileId],
  );
  if (!vinculo) return false;
  if (user.platform_admin) return true;
  const ticket = await one<{ company_id: number }>(`SELECT company_id FROM support_tickets WHERE id = ?`, [
    vinculo.ticket_id,
  ]);
  return !!ticket && ticket.company_id === user.company_id;
}

/** "Não lidas" vistas — cursor por id (uma escrita idempotente ao abrir a conversa). */
export async function marcarVisto(ticketId: number, lado: LadoChamado, autor: SessionUser): Promise<void> {
  if (lado === "empresa") {
    await run(
      `UPDATE support_tickets
          SET empresa_last_seen_id = (SELECT COALESCE(MAX(id), 0) FROM support_messages WHERE ticket_id = ?)
        WHERE id = ? AND company_id = ?`,
      [ticketId, ticketId, autor.company_id],
    );
    return;
  }
  if (!autor.platform_admin) return;
  await run(
    `UPDATE support_tickets
        SET plataforma_last_seen_id = (SELECT COALESCE(MAX(id), 0) FROM support_messages WHERE ticket_id = ?)
      WHERE id = ?`,
    [ticketId, ticketId],
  );
}

/* -------------------------------------------------------------------------- */
/* Responder                                                                   */
/* -------------------------------------------------------------------------- */

export type EntradaResposta = {
  ticketId: number;
  lado: LadoChamado;
  texto: unknown;
  arquivo?: File | null;
};

/**
 * Grava a resposta, move o status, atualiza SLA/notifica e audita.
 * Barreiras: lado 'empresa' só lê/escreve o PRÓPRIO chamado; lado 'suporte'
 * exige platform_admin (checado aqui e na action).
 */
export async function responderChamado(autor: SessionUser, entrada: EntradaResposta): Promise<void> {
  const { ticketId, lado } = entrada;
  if (lado === "suporte" && !autor.platform_admin) throw new Error("Chamado não encontrado.");
  const ticket =
    lado === "empresa" ? await chamadoDaEmpresa(ticketId, autor.company_id) : await chamadoDaPlataforma(ticketId);
  if (!ticket) throw new Error("Chamado não encontrado.");

  const corpo = limpar(entrada.texto, CORPO_MAX);
  const anexo = await gravarAnexo(entrada.arquivo);
  if (!corpo && !anexo) throw new Error("Escreva uma resposta ou anexe um arquivo.");

  // Transição: a plataforma move para 'em_andamento' (1ª resposta marca o SLA);
  // a empresa tira de 'aguardando_empresa' e reabre se estava resolvido.
  let status = ticket.status;
  let firstResponse: string | null = null;
  if (lado === "suporte") {
    status = "em_andamento";
    if (!ticket.first_response_at) firstResponse = new Date().toISOString();
  } else {
    if (ticket.status === "aguardando_empresa") status = "em_andamento";
    if (ticket.status === "resolvido") status = "aberto";
  }

  await insert(
    `INSERT INTO support_messages (ticket_id, company_id, author_id, author_kind, body, file_id, file_name, file_mime, file_size)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [ticket.id, ticket.company_id, autor.id, lado, corpo, anexo?.id ?? null, anexo?.name ?? null, anexo?.mime ?? null, anexo?.size ?? null],
  );
  await run(
    `UPDATE support_tickets
        SET status = ?,
            first_response_at = COALESCE(first_response_at, ?),
            resolved_at = CASE WHEN ? = 'resolvido' THEN COALESCE(resolved_at, datetime('now','localtime')) ELSE resolved_at END,
            updated_at = datetime('now','localtime')
      WHERE id = ?`,
    [status, firstResponse, status, ticket.id],
  );

  const link = lado === "empresa" ? `/saas/suporte/${ticket.id}` : `/suporte/${ticket.id}`;
  const titulo =
    lado === "empresa"
      ? `Resposta da empresa no chamado #${ticket.id}`
      : `O suporte respondeu o chamado #${ticket.id}`;
  if (lado === "empresa") {
    await notificar(await adminsDaPlataforma(), titulo, ticket.subject, link);
  } else {
    await notificar(await equipeDaEmpresa(ticket.company_id), titulo, ticket.subject, link);
    await emailRespostaSuporte(ticket, corpo || anexo?.name || "");
  }

  await logAction(
    autor,
    "responder",
    "suporte",
    ticket.id,
    `${autor.name} respondeu o chamado #${ticket.id} (${lado})`,
  );
}

/* -------------------------------------------------------------------------- */
/* Status                                                                      */
/* -------------------------------------------------------------------------- */

/** Empresa fecha o próprio chamado. */
export async function fecharChamado(autor: SessionUser, ticketId: number): Promise<void> {
  const ticket = await chamadoDaEmpresa(ticketId, autor.company_id);
  if (!ticket) throw new Error("Chamado não encontrado.");
  if (ticket.status === "resolvido") return;
  await run(
    `UPDATE support_tickets
        SET status = 'resolvido', resolved_at = datetime('now','localtime'), updated_at = datetime('now','localtime')
      WHERE id = ? AND company_id = ?`,
    [ticketId, autor.company_id],
  );
  await logAction(autor, "fechar", "suporte", ticketId, `${autor.name} fechou o chamado #${ticketId}`);
}

/** Empresa reabre o próprio chamado (resolvido -> aberto). */
export async function reabrirChamado(autor: SessionUser, ticketId: number): Promise<void> {
  const ticket = await chamadoDaEmpresa(ticketId, autor.company_id);
  if (!ticket) throw new Error("Chamado não encontrado.");
  if (ticket.status !== "resolvido") return;
  await run(
    `UPDATE support_tickets
        SET status = 'aberto', resolved_at = NULL, updated_at = datetime('now','localtime')
      WHERE id = ? AND company_id = ?`,
    [ticketId, autor.company_id],
  );
  await logAction(autor, "reabrir", "suporte", ticketId, `${autor.name} reabriu o chamado #${ticketId}`);
  await notificar(
    await adminsDaPlataforma(),
    `Chamado #${ticketId} reaberto`,
    ticket.subject,
    `/saas/suporte/${ticketId}`,
  );
}

/** Plataforma define qualquer status (fila/SLA). Exige platform_admin. */
export async function definirStatusPlataforma(
  autor: SessionUser,
  ticketId: number,
  novo: string,
): Promise<void> {
  if (!autor.platform_admin) throw new Error("Chamado não encontrado.");
  if (!STATUS_CHAMADO.some((s) => s.value === novo)) throw new Error("Status inválido.");
  const ticket = await chamadoDaPlataforma(ticketId);
  if (!ticket) throw new Error("Chamado não encontrado.");
  await run(
    `UPDATE support_tickets
        SET status = ?,
            resolved_at = CASE WHEN ? = 'resolvido' THEN datetime('now','localtime') ELSE NULL END,
            updated_at = datetime('now','localtime')
      WHERE id = ?`,
    [novo, novo, ticketId],
  );
  await logAction(
    autor,
    "status",
    "suporte",
    ticketId,
    `${autor.name} moveu o chamado #${ticketId} para "${novo}"`,
  );
}

/* -------------------------------------------------------------------------- */
/* Fila da plataforma (/saas/suporte)                                          */
/* -------------------------------------------------------------------------- */

export type FiltroFila = {
  /** "abertos" (padrão) | "resolvido" | "todos" */
  status?: string;
  limite?: number;
};

/**
 * Fila única de todas as empresas. A ordenação usa a prioridade AO VIVO da
 * matriz (prioridadeDaEmpresa por empresa da fila) — prioridade na frente,
 * mais antigo primeiro dentro da banda. Sem comparação de plano aqui: se uma
 * empresa Essencial ganhar cortesia/liberação Empresarial, ela sobe na hora.
 */
export async function filaPlataforma(filtro: FiltroFila = {}): Promise<Chamado[]> {
  const status = filtro.status ?? "abertos";
  const where =
    status === "todos" ? "" : status === "resolvido" ? "AND t.status = 'resolvido'" : "AND t.status <> 'resolvido'";
  const rows = await all<Chamado>(
    `SELECT ${COLUNAS_LISTA}, c.name AS company_name, pl.slug AS plan_slug
    FROM support_tickets t
    JOIN companies c ON c.id = t.company_id
    LEFT JOIN subscriptions s ON s.company_id = t.company_id
    LEFT JOIN plans pl ON pl.id = s.plan_id
    WHERE 1=1 ${where}
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT ?`,
    [filtro.limite ?? 300],
  );

  const cache = new Map<number, PrioridadeChamado>();
  for (const r of rows) {
    let p = cache.get(r.company_id);
    if (!p) {
      p = await prioridadeDaEmpresa(r.company_id);
      cache.set(r.company_id, p);
    }
    r.prioridade_viva = p;
  }
  // Sort estável: prioridade primeiro; o empate mantém a ordem (mais antigo).
  rows.sort((a, b) => (b.prioridade_viva === "prioritario" ? 1 : 0) - (a.prioridade_viva === "prioritario" ? 1 : 0));
  return rows;
}

/** Contadores do subtítulo da fila. */
export async function resumoFila(): Promise<{ abertos: number; prioritarios: number; aguardando: number }> {
  const linha = await one<{ abertos: number; prioritarios: number; aguardando: number }>(
    `SELECT
       SUM(CASE WHEN status <> 'resolvido' THEN 1 ELSE 0 END) AS abertos,
       SUM(CASE WHEN status = 'aguardando_empresa' THEN 1 ELSE 0 END) AS aguardando,
       0 AS prioritarios
     FROM support_tickets`,
  );
  // Prioritários dependem da matriz (não do priority gravado) — calcula por empresa.
  const empresas = await all<{ company_id: number }>(
    `SELECT DISTINCT company_id FROM support_tickets WHERE status <> 'resolvido'`,
  );
  let prioritarios = 0;
  for (const e of empresas) {
    if ((await prioridadeDaEmpresa(e.company_id)) === "prioritario") {
      prioritarios += await quantidadeAbertaDaEmpresa(e.company_id);
    }
  }
  return {
    abertos: linha?.abertos ?? 0,
    aguardando: linha?.aguardando ?? 0,
    prioritarios,
  };
}

async function quantidadeAbertaDaEmpresa(companyId: number): Promise<number> {
  return (
    (await scalar<number>(
      `SELECT COUNT(*) FROM support_tickets WHERE company_id = ? AND status <> 'resolvido'`,
      [companyId],
    )) ?? 0
  );
}
