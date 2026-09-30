import "server-only";
import { hashPassword } from "./password";
import { one, scalar } from "./db";

/**
 * Fluxo real de primeiro acesso (Etapa 13 do deploy).
 *
 * O banco novo do SaaS nasce sem usuarios — o seed automatico (admin/admin123)
 * NUNCA roda em producao. Este modulo permite criar exatamente UM proprietario
 * (role owner) para a empresa 1, somente enquanto a instalacao estiver vazia:
 *   - nenhuma empresa configurada (company_settings sem company_name da
 *     empresa 1); e
 *   - nenhum usuario ativo.
 *
 * Depois do primeiro acesso a rota /setup recusa novos cadastros: a criacao de
 * usuarios seguintes acontece logada, em Configuracoes -> Usuarios.
 */

export type EstadoInstalacao = {
  /** Instalacao vazia: pode criar o primeiro proprietario. */
  instalacaoVazia: boolean;
  empresaNome: string;
  jaTemOwner: boolean;
};

export async function estadoInstalacao(): Promise<EstadoInstalacao> {
  const nome = await scalar<string | null>(
    `SELECT value FROM company_settings WHERE company_id = 1 AND key = 'company_name'`,
  );
  const usuarios = await scalar<number>(`SELECT COUNT(*) FROM users WHERE active = 1`);
  return {
    instalacaoVazia: usuarios === 0 && !(nome && nome.trim() !== ""),
    empresaNome: nome ?? "",
    jaTemOwner: usuarios > 0,
  };
}

export type ResultadoSetup =
  | { ok: true; userId: number; email: string; nome: string; empresa: string }
  | { ok: false; erro: string };

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function criarPrimeiroOwner(entrada: {
  empresa: string;
  nome: string;
  username: string;
  senha: string;
  /** Obrigatório: canal dos avisos (trial, cobrança) e da recuperação de senha. */
  email?: string;
}): Promise<ResultadoSetup> {
  const estado = await estadoInstalacao();

  const nomeEmpresa = String(entrada.empresa ?? "").trim().slice(0, 120);
  const nomeUsuario = String(entrada.nome ?? "").trim().slice(0, 80);
  const username = String(entrada.username ?? "").trim().toLowerCase().slice(0, 40);
  const senha = String(entrada.senha ?? "");
  const email = String(entrada.email ?? "").trim().toLowerCase().slice(0, 120);

  if (!nomeEmpresa) return { ok: false, erro: "Informe o nome da empresa." };
  if (!nomeUsuario) return { ok: false, erro: "Informe o seu nome." };
  if (!/^[a-z0-9._-]{3,}$/.test(username))
    return { ok: false, erro: "Usuário inválido: use 3+ caracteres (letras, números, ponto, hífen ou _)." };
  if (senha.length < 8) return { ok: false, erro: "A senha precisa ter pelo menos 8 caracteres." };
  if (!email) return { ok: false, erro: "Informe o e-mail — é o canal dos avisos e da recuperação de senha." };
  if (!EMAIL_RX.test(email)) return { ok: false, erro: "E-mail inválido." };
  if (!estado.instalacaoVazia)
    return { ok: false, erro: "Esta instalação já possui um acesso configurado. Entre com o seu usuário." };

  // O escopo e a empresa 1 (instalacao nova); o usuario criado e o owner dela.
  const existente = await one<{ id: number }>(
    `SELECT id FROM users WHERE lower(username) = ?`,
    [username],
  );
  if (existente) return { ok: false, erro: "Este nome de usuário já está em uso." };

  const { run, insert } = await import("./db");
  // O primeiro acesso de uma instalacao nova e o operador da PLATAFORMA
  // (platform_admin, migration 0029): acessa o painel /saas alem do sistema.
  const userId = await insert(
    `INSERT INTO users (name, username, email, password_hash, role, active, company_id, platform_admin)
     VALUES (?,?,?,?,'owner',1,1,1)`,
    [nomeUsuario, username, email, hashPassword(senha)],
  );
  await run(
    `INSERT INTO company_settings (company_id, key, value) VALUES (1,'company_name',?)
       ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`,
    [nomeEmpresa],
  );
  // E-mail da empresa = canal comercial (avisos de cobrança/trial via owner).
  await run(`UPDATE companies SET email = ? WHERE id = 1`, [email]);
  return { ok: true, userId, email, nome: nomeUsuario, empresa: nomeEmpresa };
}
