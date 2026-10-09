import { insert, one, run, scalar } from "./db";
import { REGRAS_PADRAO } from "./push-rules";
import { documentoDoTipo, tipoPessoaValido, type TipoPessoa } from "./identidade";
import { documentoJaUsado, emailJaUsado } from "./contas";
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
  tipo_pessoa?: unknown;
  documento?: unknown;
}): {
  empresa: string;
  nome: string;
  username: string;
  senha: string;
  plano: string;
  email: string;
  tipoPessoa: TipoPessoa;
  documento: string;
} | { erro: string } {
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

  // Tipo de pessoa + documento: obrigatórios e validados no SERVIDOR
  // (a máscara da tela é só assistência — o dígito verificador é conferido aqui).
  const tipoPessoa = tipoPessoaValido(entrada.tipo_pessoa);
  if (!tipoPessoa)
    return { erro: "Selecione o tipo de pessoa: Pessoa Física (PF) ou Pessoa Jurídica (PJ)." };
  const doc = documentoDoTipo(tipoPessoa, entrada.documento);
  if (!doc.ok) return { erro: doc.erro };

  return { empresa, nome, username, senha, plano, email, tipoPessoa, documento: doc.documento };
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
  tipo_pessoa?: unknown;
  documento?: unknown;
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

  // Identidade única em TODAS as contas (o login é global): recusa antes de
  // gravar, com mensagem clara — a corrida remanescente é barrada pelo índice
  // único da migração 0037.
  if (await documentoJaUsado(dados.documento))
    return { ok: false, erro: "Este CPF/CNPJ já está cadastrado em outra conta." };
  if (await emailJaUsado(dados.email))
    return { ok: false, erro: "Este e-mail já está cadastrado em outra conta." };

  // Gravação: empresa (com e-mail de contato) -> usuário (owner, com e-mail,
  // sem platform_admin) -> settings -> trial.
  const companyId = await insert(`INSERT INTO companies (name, active, email) VALUES (?, 1, ?)`, [
    dados.empresa,
    dados.email,
  ]);

  // PJ: o CNPJ do responsável é TAMBÉM o documento da empresa (relação legítima
  // usuário-empresa, mesma informação na entidade apropriada — a cobrança
  // Asaas lê companies.document). PF: o CPF é da pessoa, a empresa fica sem
  // documento até o admin preencher em Configurações (nada é suposto).
  if (dados.tipoPessoa === "pj") {
    await run(`UPDATE companies SET document = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [
      dados.documento,
      companyId,
    ]);
  }

  const { hashPassword } = await import("./password");
  const userId = await insert(
    `INSERT INTO users (name, username, password_hash, role, active, company_id, platform_admin, email, person_type, document)
     VALUES (?,?,?,'owner',1,?,0,?,?,?)`,
    [dados.nome, dados.username, hashPassword(dados.senha), companyId, dados.email, dados.tipoPessoa, dados.documento],
  );

  // Numeração de documentos 'LOC' (regra da 0028 para empresas ≠ 1) + nome.
  await run(
    `INSERT INTO company_settings (company_id, key, value) VALUES (?, 'company_name', ?),
       (?, 'doc_prefix_reservations', 'LOC')`,
    [companyId, dados.empresa, companyId],
  );

  // Regras de notificacao da empresa nova: a 0027 deixou a tabela com uma
  // linha por tipo SO para a empresa 1 (PK antiga era 'type'); sem estas 12
  // linhas o cron nao acha regra (rule_enabled NULL -> push cancelled) e a
  // tela de preferencias mostra zero regras. INSERT OR IGNORE = idempotente.
  await run(
    `INSERT OR IGNORE INTO notification_rules (company_id, type, enabled, offsets, message)
     VALUES ${REGRAS_PADRAO.map(() => "(?,?,?,?,?)").join(",")}`,
    REGRAS_PADRAO.flatMap((r) => [companyId, r.type, r.enabled, r.offsets, r.message]),
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
