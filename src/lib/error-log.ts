import "server-only";
import { all, companyContextAtual, insert, run, scalar, runWithDb } from "./db";

/**
 * Diario de erros do servidor (tabela error_logs, migration 0026).
 *
 * O Workers manda cada console.error para os logs do Cloudflare, mas la nada
 * fica pesquisavel dentro do proprio sistema — e sem acesso ao dashboard quem
 * opera a aplicacao nunca descobre o que quebrou. Este modulo grava cada erro
 * com contexto minimo (rota, metodo, usuario) em uma unica linha, e o cron
 * diario poda o que passou de 30 dias.
 *
 * PENDÊNCIA #07 (escopo de empresa): cada linha nasce com o company_id DONO
 * do erro — o da sessão/usuario afetado em request, o do contexto runWithCompany
 * no cron — e com NULL quando o erro e GLOBAL (sem empresa). A tela /erros
 * filtra por company_id da sessão; NULL so casaria com a visao sem filtro do
 * platform_admin, entao erro global nunca vaza para um cliente.
 *
 * REGRA DE OURO: registrar erro NUNCA pode quebrar o fluxo original. Toda
 * funcao aqui engole a propria falha (console.error de emergencia) e devolve
 * silencio — se o banco estiver fora do ar, o erro original importa mais do
 * que a falha de registra-lo.
 */

/** ID do usuario logado, sem importar auth (evita ciclo e falha fora de request). */
async function usuarioCorrente(): Promise<{ id: number | null; name: string }> {
  try {
    const { requireUser } = await import("./auth");
    // Pendência #05: /api/log-erro fica de fora do gate de assinatura — o
    // diário de erros precisa registrar o problema mesmo da conta bloqueada.
    const u = await requireUser({ bloqueio: "ignorar" });
    return { id: u.id, name: u.name };
  } catch {
    return { id: null, name: "" };
  }
}

/**
 * Empresa da sessão atual (request), ou null fora de request/sem sessão.
 *
 * Usa companyContext (e nao requireUser) porque ele devolve null em vez de
 * redirecionar: resolucao de escopo nunca pode mexer no fluxo original.
 * Import dinâmico para nao puxar auth no carregamento do modulo (cron).
 */
async function empresaDaSessao(): Promise<number | null> {
  try {
    const { companyContext } = await import("./auth");
    const ctx = await companyContext();
    return ctx?.companyId ?? null;
  } catch {
    return null;
  }
}

/** Uma linha de erro pronta para o banco. */
export type ErroLog = {
  source: "onRequestError" | "api/log-erro" | "cron";
  kind: "server" | "client";
  message: string;
  route?: string | null;
  method?: string | null;
  digest?: string | null;
  userId?: number | null;
  userName?: string | null;
  context?: Record<string, unknown>;
  /**
   * Escopo da linha (pendência #07):
   *
   *  * número       → empresa dona (ex.: falha de cron por empresa);
   *  * `null`       → erro GLOBAL de propósito, sem empresa;
   *  * omitido      → resolve sozinho: usuário afetado → sessão → contexto de
   *                   cron (runWithCompany) → NULL global.
   */
  companyId?: number | null;
};

const MAX = 4000;

/** "TypeError: Cannot read properties of undefined" — tipo + mensagem (e causa), sem stack. */
export function mensagemDeErro(erro: unknown): string {
  if (erro instanceof Error) {
    const causa = erro.cause instanceof Error ? ` (causa: ${erro.cause.name}: ${erro.cause.message})` : "";
    return `${erro.name}: ${erro.message}${causa}`.slice(0, MAX);
  }
  return String(erro ?? "Erro desconhecido").slice(0, MAX);
}

function paraJson(valor: unknown): string | null {
  try {
    const texto = JSON.stringify(valor);
    return texto === undefined ? null : texto.slice(0, MAX);
  } catch {
    return null;
  }
}

/**
 * Empresa dona da linha (pendência #07). Nunca lança: qualquer falha aqui
 * vira NULL (global) em vez de perder o registro do erro original.
 *
 * Ordem: escopo explícito → usuário afetado → sessão da request → contexto de
 * cron (runWithCompany) → NULL. O fallback antigo era `currentCompanyId()`
 * (empresa padrao = 1), que jogava TODOS os erros sem empresa na empresa 1 —
 * ela enxergava os das outras (vazamento) e as demais nao viam nada proprio.
 */
async function resolverCompanyId(erro: ErroLog): Promise<number | null> {
  // 1) Chamador ja sabe: cron por empresa passa o id; null = global declarado.
  if (erro.companyId !== undefined) return erro.companyId;

  // 2) Empresa do usuário afetado (onRequestError/registrarErroComUsuario).
  if (erro.userId) {
    try {
      const cid = await scalar<number>(`SELECT company_id FROM users WHERE id = ?`, [erro.userId]);
      if (cid && cid > 0) return cid;
      // usuário não existe mais: cai nas etapas seguintes (sem DEFAULT 1)
    } catch {
      // banco fora do ar não pode derrubar o registro — segue a busca
    }
  }

  // 3) Request com sessão: a empresa vem do cookie (auth.companyContext).
  const sessao = await empresaDaSessao();
  if (sessao) return sessao;

  // 4) Cron: a empresa corrente fixada por runWithCompany (db, import estatico).
  const fixada = companyContextAtual();
  if (fixada !== undefined) return fixada;

  // 5) Global de verdade (cron de plataforma, erro sem sessão): company_id NULL.
  return null;
}

/** Grava o erro e resolve mesmo se o INSERT falhar. Devolve o id, ou null. */
export async function registrarErro(erro: ErroLog): Promise<number | null> {
  try {
    const companyId = await resolverCompanyId(erro);
    return await insert(
      `INSERT INTO error_logs (created_at, source, kind, route, method, message, digest, user_id, user_name, context, company_id)
       VALUES (unixepoch(),?,?,?,?,?,?,?,?,?,?)`,
      [
        erro.source,
        erro.kind,
        erro.route ?? null,
        erro.method ?? null,
        erro.message.slice(0, MAX),
        erro.digest ?? null,
        erro.userId ?? null,
        erro.userName ?? null,
        paraJson(erro.context),
        companyId,
      ],
    );
  } catch (e) {
    // O diagnostico nao pode competir com a aplicacao: se o registro falhar,
    // o erro original segue o curso dele.
    console.error("[error-log] falha ao registrar erro:", mensagemDeErro(e));
    return null;
  }
}

/** Nao sabe o usuario de antemao? Este wrapper resolve e grava. */
export async function registrarErroComUsuario(erro: Omit<ErroLog, "userId" | "userName">): Promise<number | null> {
  const usuario = await usuarioCorrente().catch(() => ({ id: null, name: "" }));
  return registrarErro({ ...erro, userId: usuario.id, userName: usuario.name });
}

const DIA = 86400;
const RETENCAO_DIAS = 30;

/** Poda erros com mais de 30 dias. Chamada pelo cron diario. */
export async function podarErrosAntigos(db: D1Database): Promise<number> {
  try {
    return await runWithDb(db, async () => {
      await run(`DELETE FROM error_logs WHERE created_at < unixepoch() - ?`, [RETENCAO_DIAS * DIA]);
      return await scalar<number>(`SELECT changes()`);
    });
  } catch (e) {
    console.error("[error-log] poda falhou:", mensagemDeErro(e));
    return 0;
  }
}

/* --------------------------------- consulta --------------------------------- */

/**
 * Diário de erros POR EMPRESA.
 *
 * Com companyId informado (tela do locador): só os erros da própria empresa.
 * Sem (painel da plataforma/cron): visão global — a consulta ampla é usada
 * apenas por quem tem o ambiente /saas.
 */
export async function contarErros(kind: "server" | "client", companyId?: number | null): Promise<number> {
  try {
    const escopo = companyId ? " AND company_id = ?" : "";
    return await scalar<number>(`SELECT COUNT(*) FROM error_logs WHERE kind = ? AND resolved = 0${escopo}`, companyId ? [kind, companyId] : [kind]);
  } catch {
    return 0;
  }
}

export async function ultimosErros(kind: "server" | "client", limite = 50, offset = 0, companyId?: number | null) {
  try {
    const escopo = companyId ? " AND company_id = ?" : "";
    return await all<any>(`SELECT * FROM error_logs WHERE kind = ?${escopo} ORDER BY id DESC LIMIT ? OFFSET ?`, companyId ? [kind, companyId, limite, offset] : [kind, limite, offset]);
  } catch {
    return [];
  }
}

/** Marca como tratado (ou reabre). Com companyId, só erros da própria empresa. */
export async function marcarResolvido(id: number, resolvido: boolean, companyId?: number | null): Promise<void> {
  try {
    if (companyId) {
      await run(`UPDATE error_logs SET resolved = ? WHERE id = ? AND company_id = ?`, [resolvido ? 1 : 0, id, companyId]);
    } else {
      await run(`UPDATE error_logs SET resolved = ? WHERE id = ?`, [resolvido ? 1 : 0, id]);
    }
  } catch {
    /* tela de diagnostico: falha aqui nao precisa de tratamento */
  }
}

export const ERROS_POR_PAGINA = 50;
