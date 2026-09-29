import { insert, one, run, scalar } from "./db";
import type { ResultadoSetup } from "./primeiro-acesso";

/**
 * Onboarding comercial (Etapa 4): cadastro PÚBLICO de uma NOVA empresa.
 *
 * Enquanto o /setup cria o primeiro dono da instalação (empresa 1, uma única
 * vez), este módulo é o caminho de crescimento: cada assinatura pelo checkout
 * cria uma empresa própria, o owner dela e o trial — sem tocar nas empresas
 * existentes e sem depender de painel interno.
 *
 * Diferenças deliberadas para o /setup:
 *  * company_id é AUTOINCREMENT (nunca fixo em 1);
 *  * numeração de documentos 'LOC' (regra da 0028 para empresas ≠ 1);
 *  * platform_admin = 0: cliente NÃO é operador da plataforma (painel /saas);
 *  * trial no plano escolhido no checkout (assinatura criada na hora, no
 *    mesmo padrão do gancho automático de assinaturaDaEmpresa).
 *
 * Sem import "server-only" (igual a billing.ts): o módulo precisa ser
 * carregável nos testes (node:test + FakeD1) fora do bundle do Next.
 */

export const DIAS_TRIAL_PADRAO = 14;

export type ResultadoOnboarding =
  | {
      ok: true;
      userId: number;
      companyId: number;
      trialEndsAt: string;
      /** E-mail do owner (canal dos avisos comerciais). */
      email: string;
      nome: string;
      empresa: string;
    }
  | { ok: false; erro: string };

function texto(v: unknown, max: number): string {
  return String(v ?? "").trim().slice(0, max);
}

/** Próximo dia no fuso de Brasília (mesma regra de billing.hojeISO). */
function diaISO(offsetDays: number): string {
  return new Date(Date.now() - 3 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);
}

const EMAIL_RX = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Valida e normaliza os dados do checkout. Separada da gravação para poder
 * ser exercitada isoladamente nos testes. O e-mail é OBRIGATÓRIO: é o canal
 * dos avisos (boas-vindas, fim de trial, cobrança) e da recuperação de senha.
 */
export function validarCadastro(entrada: {
  empresa?: unknown;
  nome?: unknown;
  username?: unknown;
  senha?: unknown;
  plano?: unknown;
  email?: unknown;
}): { empresa: string; nome: string; username: string; senha: string; plano: string; email: string } | { erro: string } {
  const empresa = texto(entrada.empresa, 120);
  const nome = texto(entrada.nome, 80);
  const username = texto(entrada.username, 40).toLowerCase();
  const senha = String(entrada.senha ?? "");
  const plano = texto(entrada.plano, 40).toLowerCase();
  const email = texto(entrada.email, 120).toLowerCase();

  if (!empresa) return { erro: "Informe o nome da empresa." };
  if (!nome) return { erro: "Informe o seu nome." };
  if (!/^[a-z0-9._-]{3,}$/.test(username))
    return { erro: "Usuário inválido: use 3+ caracteres (letras, números, ponto, hífen ou _)." };
  if (senha.length < 8) return { erro: "A senha precisa ter pelo menos 8 caracteres." };
  if (!plano) return { erro: "Escolha um plano." };
  if (!EMAIL_RX.test(email)) return { erro: "Informe um e-mail válido — é para lá que vão os avisos da conta." };

  return { empresa, nome, username, senha, plano, email };
}

/**
 * Cria empresa + owner + configurações + trial em uma idempotência só de
 * leitura: valida tudo ANTES de gravar qualquer linha, então um erro a meio
 * caminho é improvável (o D1 remoto não aceita transação SQL explícita — o
 * caminho seguro é não deixar o erro acontecer).
 *
 * Rejeita username já usado (users.username é UNIQUE global), plano inativo e
 * empresa duplicada com o mesmo nome ATIVO (defesa extra contra duplo clique;
 * nomes iguais de empresas distintas não são proibidos pelo schema, então a
 * checagem fica aqui, não no banco).
 */
export async function criarEmpresaComTrial(entrada: {
  empresa?: unknown;
  nome?: unknown;
  username?: unknown;
  senha?: unknown;
  plano?: unknown;
  email?: unknown;
}): Promise<ResultadoOnboarding> {
  const dados = validarCadastro(entrada);
  if ("erro" in dados) return { ok: false, erro: dados.erro };

  const plano = await one<{ id: number; trial_days: number }>(
    `SELECT id, trial_days FROM plans WHERE slug = ? AND active = 1`,
    [dados.plano],
  );
  if (!plano) return { ok: false, erro: "Plano indisponível. Escolha outro plano." };

  if (await one<{ id: number }>(`SELECT id FROM users WHERE lower(username) = ?`, [dados.username]))
    return { ok: false, erro: "Este nome de usuário já está em uso." };

  if (
    await one<{ id: number }>(
      `SELECT id FROM companies WHERE lower(name) = lower(?) AND active = 1`,
      [dados.empresa],
    )
  )
    return {
      ok: false,
      erro: "Já existe uma empresa ativa com este nome. Escolha outro nome ou fale com o suporte.",
    };

  // Gravação: empresa (com e-mail de contato) -> usuário (owner, com e-mail,
  // sem platform_admin) -> settings -> trial.
  const companyId = await insert(`INSERT INTO companies (name, active, email) VALUES (?, 1, ?)`, [
    dados.empresa,
    dados.email,
  ]);

  const { hashPassword } = await import("./password");
  const userId = await insert(
    `INSERT INTO users (name, username, password_hash, role, active, company_id, platform_admin, email)
     VALUES (?,?,?,'owner',1,?,0,?)`,
    [dados.nome, dados.username, hashPassword(dados.senha), companyId, dados.email],
  );

  // Numeração de documentos 'LOC' (regra da 0028 para empresas ≠ 1) + nome.
  await run(
    `INSERT INTO company_settings (company_id, key, value) VALUES (?, 'company_name', ?),
       (?, 'doc_prefix_reservations', 'LOC')`,
    [companyId, dados.empresa, companyId],
  );

  // Trial na hora: mesma semântica do gancho automático de billing, mas com
  // o plano escolhido — a rota de checkout chama de novo só para ler.
  const dias = plano.trial_days || DIAS_TRIAL_PADRAO;
  const hoje = diaISO(0);
  await insert(
    `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
     VALUES (?,?, 'trial', ?, ?, ?)`,
    [companyId, plano.id, diaISO(dias), hoje, diaISO(dias)],
  );

  return { ok: true, userId, companyId, trialEndsAt: diaISO(dias), email: dados.email, nome: dados.nome, empresa: dados.empresa };
}

/** Contadores para o rodapé da landing (prova social honesta, sem PII). */
export async function metricasPublicas(): Promise<{ empresas: number }> {
  const empresas = await scalar<number>(`SELECT COUNT(*) FROM companies WHERE active = 1`);
  return { empresas };
}
