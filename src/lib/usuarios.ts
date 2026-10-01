/**
 * Gestão de usuários da empresa — regras de NEGÓCIO e de AUTORIZAÇÃO.
 *
 * Módulo puro (sem next/*): as server actions de configuracoes são apenas
 * wrappers de sessão; a barreira de segurança vive AQUI, onde é testável.
 *
 * Hierarquia respeitada:
 *  - `ator` é o administrador da empresa (owner | admin) que executa a ação.
 *  - O ator só enxerga e altera usuários da PRÓPRIA empresa (users.company_id
 *    do ator, nunca um companyId vindo do cliente).
 *  - Papéis de destino são whitelist fechada: "admin" | "operacional".
 *    Ninguém cria "owner" (o dono da empresa é único e nasce na instalação/
 *    onboarding), ninguém cria platform_admin (coluna nunca entra no INSERT),
 *    e papéis inválidos/estranhos viram erro — nunca um papel elevado.
 *  - Cada usuário não pode alterar o PRÓPRIO papel (escalada) nem tocar na
 *    conta do owner da empresa.
 *  - O limite do plano é conferido no banco na criação (podeCriarUsuario).
 */

import { all, insert, one, run, scalar } from "./db";
import { hashPassword } from "./password";
import { podeCriarUsuario } from "./billing";

export type PapelUsuario = "owner" | "admin" | "operacional" | "financeiro" | "viewer";

/** Atores: sessão mínima necessária para executar ações de usuários. */
export type Ator = {
  id: number;
  name: string;
  company_id: number;
  role: PapelUsuario;
};

/** Administrador da empresa (owner ou admin secundário). */
export function ehAdminEmpresa(role: PapelUsuario): boolean {
  return role === "owner" || role === "admin";
}

/** Papéis que um administrador de empresa pode atribuir. Whitelist fechada. */
export const PAPEIS_ATRIBUIVEIS = ["admin", "operacional"] as const;
export type PapelAtribuivel = (typeof PAPEIS_ATRIBUIVEIS)[number];

/** Aceita apelidos do formulário ("operador") e recusa tudo que não mapeia. */
export function papelValido(valor: string): PapelAtribuivel | null {
  const v = String(valor ?? "").trim().toLowerCase();
  if (v === "admin") return "admin";
  if (v === "operacional" || v === "operador") return "operacional";
  return null;
}

function autorizacaoFalha(ator: Ator): string | null {
  if (!ator || typeof ator.company_id !== "number") return "Sessão inválida.";
  if (!ehAdminEmpresa(ator.role)) return "Somente o administrador da empresa pode gerenciar usuários.";
  return null;
}

export type Resultado = { ok: true; id?: number } | { ok: false; erro: string };

/** Usuário da empresa alvo, ou null se o id não pertence à empresa do ator. */
async function usuarioDaEmpresa(ator: Ator, id: number) {
  return await one<{
    id: number;
    name: string;
    username: string;
    role: PapelUsuario;
    active: number;
    company_id: number;
    platform_admin?: number;
  }>(`SELECT id, name, username, role, active, company_id, platform_admin FROM users WHERE id = ? AND company_id = ?`, [
    id,
    ator.company_id,
  ]);
}

/* -------------------------------- listagem ------------------------------- */

/** Usuários DA EMPRESA do ator — nada de outra empresa vaza aqui. */
export async function listarUsuarios(companyId: number) {
  return await all(
    `SELECT id, name, username, email, phone, role, active, avatar_url, created_at, platform_admin
       FROM users WHERE company_id = ? ORDER BY name`,
    [companyId],
  );
}

/* ------------------------------- criação ------------------------------- */

export async function criarUsuario(
  ator: Ator,
  dados: { name: string; username: string; email?: string; phone?: string; password: string; role: string },
  log?: (acao: string, entidade: string, id: number | null, resumo: string) => Promise<void>,
): Promise<Resultado> {
  const falha = autorizacaoFalha(ator);
  if (falha) return { ok: false, erro: falha };

  const name = String(dados.name ?? "").trim();
  const username = String(dados.username ?? "").trim().toLowerCase();
  const password = String(dados.password ?? "");
  const papel = papelValido(dados.role);
  if (!name || !username) return { ok: false, erro: "Informe nome e usuário." };
  if (password.length < 6) return { ok: false, erro: "A senha deve ter ao menos 6 caracteres." };
  if (!papel) {
    // Whitelist: qualquer papel fora de admin/operacional (owner, platform_admin,
    // strings maliciosas) é recusado — nunca mapeado para algo elevado.
    return { ok: false, erro: "Função inválida para usuários da empresa." };
  }
  if (
    (await scalar<number>(`SELECT COUNT(*) FROM users WHERE username = ?`, [username])) > 0
  ) {
    return { ok: false, erro: "Usuário já existe." };
  }

  // Limite do plano: validado AQUI, no backend, contra o banco.
  const limite = await podeCriarUsuario(ator.company_id);
  if (!limite.ok) return { ok: false, erro: limite.motivo ?? "Limite do plano atingido." };

  const id = await insert(
    `INSERT INTO users (name, username, email, phone, password_hash, role, company_id)
     VALUES (?,?,?,?,?,?,?)`,
    [name, username, String(dados.email ?? "").trim(), String(dados.phone ?? "").trim(), hashPassword(password), papel, ator.company_id],
  );
  if (log) await log("criar", "usuario", id, `${ator.name} criou o usuario ${name} (${papel})`);
  return { ok: true, id };
}

/* ------------------------------- edição ------------------------------- */

export async function atualizarUsuario(
  ator: Ator,
  id: number,
  dados: { name: string; username: string; email?: string; phone?: string; role: string },
  log?: (acao: string, entidade: string, id: number | null, resumo: string) => Promise<void>,
): Promise<Resultado> {
  const falha = autorizacaoFalha(ator);
  if (falha) return { ok: false, erro: falha };

  const alvo = await usuarioDaEmpresa(ator, id);
  if (!alvo) return { ok: false, erro: "Usuário não encontrado." };
  // Escalada: ninguém altera o PRÓPRIO papel (nem para baixo, nem para cima).
  if (id === ator.id) return { ok: false, erro: "Não é possível alterar o seu próprio papel." };
  if (alvo.role === "owner") return { ok: false, erro: "A conta do proprietário da empresa não pode ser alterada aqui." };

  const name = String(dados.name ?? "").trim();
  const username = String(dados.username ?? "").trim().toLowerCase();
  const papel = papelValido(dados.role);
  if (!name || !username) return { ok: false, erro: "Informe nome e usuário." };
  if (!papel) return { ok: false, erro: "Função inválida para usuários da empresa." };
  if (
    (await scalar<number>(`SELECT COUNT(*) FROM users WHERE username = ? AND id <> ?`, [username, id])) > 0
  ) {
    return { ok: false, erro: "Usuário já existe." };
  }

  await run(
    `UPDATE users SET name = ?, username = ?, email = ?, phone = ?, role = ? WHERE id = ? AND company_id = ?`,
    [name, username, String(dados.email ?? "").trim(), String(dados.phone ?? "").trim(), papel, id, ator.company_id],
  );
  if (log) await log("editar", "usuario", id, `${ator.name} alterou o usuario ${name} (${papel})`);
  return { ok: true };
}

/* --------------------------- ativar / desativar --------------------------- */

export async function alternarStatusUsuario(
  ator: Ator,
  id: number,
  log?: (acao: string, entidade: string, id: number | null, resumo: string) => Promise<void>,
): Promise<Resultado> {
  const falha = autorizacaoFalha(ator);
  if (falha) return { ok: false, erro: falha };

  const alvo = await usuarioDaEmpresa(ator, id);
  if (!alvo) return { ok: false, erro: "Usuário não encontrado." };
  if (id === ator.id) return { ok: false, erro: "Você não pode inativar a sua própria conta." };
  if (alvo.role === "owner") return { ok: false, erro: "A conta do proprietário da empresa não pode ser inativada." };

  await run(`UPDATE users SET active = ? WHERE id = ? AND company_id = ?`, [alvo.active ? 0 : 1, id, ator.company_id]);
  if (log) {
    await log(
      alvo.active ? "inativar" : "reativar",
      "usuario",
      id,
      `${ator.name} ${alvo.active ? "inativou" : "reativou"} ${alvo.name}`,
    );
  }
  return { ok: true };
}

/* ------------------------------- exclusão ------------------------------- */

/**
 * Exclui o usuário DE FATO (libera a vaga do plano imediatamente).
 *
 * Regra de segurança: só usuários SEM registros vinculados podem ser
 * apagados — mensagens de chat, lançamentos financeiros e recibos referenciam
 * o usuário (FK sem cascade) e são histórico da empresa. Nesses casos o
 * backend recusa e indica a inativação, que libera a vaga sem apagar histórico.
 */
export async function excluirUsuario(
  ator: Ator,
  id: number,
  log?: (acao: string, entidade: string, id: number | null, resumo: string) => Promise<void>,
): Promise<Resultado> {
  const falha = autorizacaoFalha(ator);
  if (falha) return { ok: false, erro: falha };

  const alvo = await usuarioDaEmpresa(ator, id);
  if (!alvo) return { ok: false, erro: "Usuário não encontrado." };
  if (id === ator.id) return { ok: false, erro: "Você não pode excluir a sua própria conta." };
  if (alvo.role === "owner") return { ok: false, erro: "A conta do proprietário da empresa não pode ser excluída." };

  const vinculos = [
    { tabela: "chat_messages", coluna: "sender_id", rotulo: "mensagens do chat" },
    { tabela: "expenses", coluna: "created_by", rotulo: "saídas financeiras" },
    { tabela: "payments", coluna: "created_by", rotulo: "recebimentos" },
    { tabela: "receipts", coluna: "issued_by", rotulo: "recibos" },
    { tabela: "contracts", coluna: "created_by", rotulo: "contratos" },
    { tabela: "reservations", coluna: "created_by", rotulo: "reservas" },
  ];
  for (const v of vinculos) {
    const n = await scalar<number>(`SELECT COUNT(*) FROM ${v.tabela} WHERE ${v.coluna} = ?`, [id]);
    if (n > 0) {
      return {
        ok: false,
        erro: `${alvo.name} tem ${n} registro(s) vinculados (${v.rotulo}). Inative o usuário em vez de excluir, para preservar o histórico.`,
      };
    }
  }

  await run(`DELETE FROM sessions WHERE user_id = ?`, [id]);
  await run(`DELETE FROM push_subscriptions WHERE user_id = ?`, [id]);
  await run(`DELETE FROM user_notifications WHERE user_id = ?`, [id]);
  await run(`DELETE FROM notification_preferences WHERE user_id = ?`, [id]);
  await run(`DELETE FROM users WHERE id = ? AND company_id = ?`, [id, ator.company_id]);
  if (log) await log("excluir", "usuario", id, `${ator.name} excluiu o usuario ${alvo.name}`);
  return { ok: true };
}
