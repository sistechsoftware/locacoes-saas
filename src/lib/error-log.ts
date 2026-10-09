import "server-only";
import { all, currentCompanyId, insert, run, scalar, runWithDb } from "./db";

/**
 * Diario de erros do servidor (tabela error_logs, migration 0026).
 *
 * O Workers manda cada console.error para os logs do Cloudflare, mas la nada
 * fica pesquisavel dentro do proprio sistema — e sem acesso ao dashboard quem
 * opera a aplicacao nunca descobre o que quebrou. Este modulo grava cada erro
 * com contexto minimo (rota, metodo, usuario) em uma unica linha, e o cron
 * diario poda o que passou de 30 dias.
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

/** Grava o erro e resolve mesmo se o INSERT falhar. Devolve o id, ou null. */
export async function registrarErro(erro: ErroLog): Promise<number | null> {
  try {
    /* Pendência #04: a empresa do erro = empresa do usuário afetado; sem
       sessão (cron/onRequestError) vale a empresa corrente do contexto.
       Qualquer falha aqui e engolida — o diário nunca derruba o fluxo.
       Pendência #08 (decisão #06): error_logs segue a MESMA regra do
       audit_logs, mas com UMA coluna só (company_id) — a tabela nasceu
       depois do multi-tenant (0026/0027) e nunca teve a cisão company_id_ref.
       A migration 0033 backfilla as linhas legadas pelo usuário dono. */
    let companyId = 1;
    try {
      companyId = erro.userId
        ? (await scalar<number>(`SELECT company_id FROM users WHERE id = ?`, [erro.userId])) ?? 1
        : await currentCompanyId();
    } catch {
      // segue com 1 (DEFAULT) em vez de perder o registro
    }
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
