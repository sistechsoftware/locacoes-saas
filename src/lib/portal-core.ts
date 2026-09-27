import crypto from "node:crypto";
import { insert, one, run, scalar } from "./db";
import { onlyDigits } from "./format";
import { rateLimit } from "./rate-limit";

/**
 * Regras do acesso do Portal do Cliente, sem next/headers nem next/navigation.
 *
 * Este arquivo existe para a regra ser testavel sozinha — o mesmo criterio de
 * auth.ts (funcoes puras de senha) e fidelidade.ts (regra sem banco). O lado
 * que toca cookie e redirect vive em portal-auth.ts, e chama as funcoes daqui.
 *
 * Estrategia: CPF + senha. O cadastro de clientes (customers) nao tinha
 * credencial nenhuma — nem usuarios, nem tabela de login — entao a conta nasce
 * de um convite: a equipe gera um token de primeiro acesso, o cliente recebe
 * pelo WhatsApp e, para definir a senha, confirma o TELEFONE cadastrado, que
 * so quem e o cliente conhece. O token interceptado na mensagem, sozinho, nao
 * configura a conta.
 *
 * O hash do token segue o padrao do link de assinatura digital
 * (assinatura-db.ts: SHA-256, so o hash no banco) e as senhas usam a mesma
 * primitiva scrypt com salt das senhas internas (auth.ts). Nada de senha em
 * texto ou hash fraco.
 */

/** O login e por CPF: 11 digitos, com digitos verificadores validos. */
export const CPF_LEN = 11;

/** CPF: 11 digitos e digitos verificador validos (recusa sequencias). */
export function cpfValido(cpf: string): boolean {
  const d = onlyDigits(cpf);
  if (d.length !== CPF_LEN) return false;
  if (/^(\d)\1{10}$/.test(d)) return false;
  let soma = 0;
  for (let i = 0; i < 9; i++) soma += Number(d[i]) * (10 - i);
  let resto = (soma * 10) % 11;
  if (resto === 10) resto = 0;
  if (resto !== Number(d[9])) return false;
  soma = 0;
  for (let i = 0; i < 10; i++) soma += Number(d[i]) * (11 - i);
  resto = (soma * 10) % 11;
  if (resto === 10) resto = 0;
  return resto === Number(d[10]);
}

/** Digitos de um telefone cadastrado (usado na verificacao do primeiro acesso). */
const digitosFone = (s: string | null | undefined) => onlyDigits(s).slice(-11);

/* ------------------------------ origem do portal ------------------------------ */

/**
 * Origem absoluta do portal ("https://host") derivada da propria requisicao.
 *
 * O link do convite precisa sair completo para o cliente abrir pelo WhatsApp,
 * e a origem certa muda conforme onde a equipe acessa: workers.dev, dominio
 * proprio ou localhost. Em vez de exigir configuracao, lemos os cabecalhos da
 * requisicao que clicou em "gerar convite" — o mesmo endereco na barra do
 * navegador de quem gerou. PORTAL_BASE_URL, quando definida, segue valendo
 * como escolha explicita por cima deste calculo.
 *
 * Funcao pura (recebe Headers): testavel sem servidor, como o resto da regra.
 * Host malformado devolve "" e o link sai relativo — degrada, nao quebra.
 */
export function origemDaRequisicao(h: Headers): string {
  // x-forwarded-host vem do proxy (Cloudflare) e e o host real do visitante;
  // host e o cabecalho padrao da requisicao
  const host = (h.get("x-forwarded-host") ?? h.get("host") ?? "").trim();
  if (!host || !/^[\w.-]+(:\d+)?$/.test(host)) return "";
  const proto = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim().toLowerCase();
  if (proto === "http" || proto === "https") return `${proto}://${host}`;
  // sem cabecalho de proxy: dev local roda em http, producao em https
  const local = /^(localhost|127\.\.?|0\.0\.0\.0|\[::1\])/i.test(host);
  return `${local ? "http" : "https"}://${host}`;
}

/* ------------------------------ senhas ------------------------------ */

/** Mesma primitiva das senhas dos usuarios internos: scrypt com salt. */
export function hashSenhaCliente(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verificaSenhaCliente(password: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

/* --------------------------- convite de acesso --------------------------- */

export type ConviteGerado = { token: string; expires_at: string; whatsapp: string | null; customer_name: string };

/**
 * Gera o convite de primeiro acesso (ou a redefinicao de senha) de um cliente.
 *
 * Nao existe token legivel no banco: grava o SHA-256. Gerar de novo revoga o
 * convite anterior — so o mais recente vale, igual ao link de assinatura.
 */
export async function gerarConviteAcesso(
  customerId: number,
  diasValidade = 7,
): Promise<ConviteGerado | null> {
  const c = await one<any>(
    `SELECT id, name, whatsapp, phone FROM customers WHERE id = ? AND active = 1`,
    [customerId],
  );
  if (!c) return null;

  const token = crypto.randomBytes(24).toString("base64url");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const expires = new Date(Date.now() + diasValidade * 864e5);
  const expiresISO = expires.toISOString();

  await run(
    `UPDATE customers SET portal_setup_token_hash = ?, portal_setup_expires_at = ?
      WHERE id = ?`,
    [hash, expiresISO, customerId],
  );

  const nome = String(c.name ?? "").trim();
  const digits = onlyDigits(String(c.whatsapp || c.phone || ""));
  const wa = digits ? (digits.length <= 11 ? `https://wa.me/55${digits}` : `https://wa.me/${digits}`) : null;
  return { token, expires_at: expiresISO, whatsapp: wa, customer_name: nome };
}

/** Estado do acesso do cliente para a tela administrativa. */
export async function acessoPortalDe(customerId: number) {
  return await one<any>(
    `SELECT portal_password_hash, portal_setup_token_hash, portal_setup_expires_at
       FROM customers WHERE id = ?`,
    [customerId],
  );
}

/* ------------------------------ primeiro acesso ------------------------------ */

export type SetupResultado = { ok: true } | { ok: false; erro: string };

/**
 * Define a senha no primeiro acesso (ou na redefinicao).
 *
 * Toda regra critica e conferida aqui, no servidor: token com hash existente e
 * nao expirado, CPF com digitos verificadores validos, telefone cadastrado
 * conferido e senha com tamanho minimo. O token e queimado ao concluir.
 */
export async function configurarAcesso(entrada: {
  token: string;
  cpf: string;
  telefone: string;
  password: string;
}): Promise<SetupResultado> {
  const token = String(entrada.token ?? "");
  const cpf = onlyDigits(entrada.cpf);
  const telefone = digitosFone(String(entrada.telefone ?? ""));
  const password = String(entrada.password ?? "");

  if (!token || token.length > 128) return { ok: false, erro: "Convite inválido. Peça um novo link à Lima's." };
  if (!cpfValido(cpf)) return { ok: false, erro: "CPF inválido. Confira os números digitados." };
  if (telefone.length < 10) return { ok: false, erro: "Informe o telefone cadastrado na Lima's (com DDD)." };
  if (password.length < 8) return { ok: false, erro: "A senha precisa ter pelo menos 8 caracteres." };

  const hash = crypto.createHash("sha256").update(token).digest("hex");
  // o CPF entra na busca: token + CPF precisam apontar para o MESMO cliente
  const c = await one<any>(
    `SELECT id, phone, whatsapp, portal_setup_token_hash, portal_setup_expires_at
       FROM customers
      WHERE portal_setup_token_hash = ? AND replace(replace(replace(replace(replace(doc,'.',''),'-',''),'(',''),')',''),' ','') = ?
        AND active = 1`,
    [hash, cpf],
  );
  // mesma mensagem para token errado, CPF errado ou expirado: quem tenta nao
  // descobre qual das tres falhou
  if (!c) return { ok: false, erro: "Convite, CPF ou telefone não conferem. Revise os dados ou peça um novo link." };
  if (!c.portal_setup_token_hash || (c.portal_setup_expires_at && new Date(c.portal_setup_expires_at) < new Date())) {
    return { ok: false, erro: "Este convite expirou. Peça um novo link à Lima's." };
  }

  // a confirmacao do telefone cadastrado e o segundo fator do convite
  const fones = [digitosFone(c.phone), digitosFone(c.whatsapp)].filter(Boolean);
  if (fones.length > 0 && !fones.includes(telefone)) {
    return { ok: false, erro: "Convite, CPF ou telefone não conferem. Revise os dados ou peça um novo link." };
  }

  // trava otimista: so grava se o token ainda e o mesmo, entao dois envios
  // simultaneos nao criam duas contas nem deixam o token reutilizavel
  const marcou = await run(
    `UPDATE customers
        SET portal_password_hash = ?, portal_setup_token_hash = NULL, portal_setup_expires_at = NULL
      WHERE id = ? AND portal_setup_token_hash = ?`,
    [hashSenhaCliente(password), c.id, hash],
  );
  if (!marcou.meta.changes) return { ok: false, erro: "Este convite já foi utilizado. Faça login normalmente." };

  await run(`DELETE FROM portal_sessions WHERE customer_id = ?`, [c.id]);
  return { ok: true };
}

/* ------------------------------ login ------------------------------ */

/** Resultado da tentativa de login: erro para a tela, cliente para a sessao. */
export type TentativaLogin = { erro: string | null; customerId: number | null };

/** Autentica por CPF + senha. Nao abre sessao: quem chama decide o que fazer. */
export async function tentarLogin(cpf: string, password: string): Promise<TentativaLogin> {
  const cpfDig = onlyDigits(cpf);
  if (!cpfDig || !password) return { erro: "Informe o CPF e a senha.", customerId: null };
  if (!cpfValido(cpfDig)) return { erro: "CPF ou senha inválidos.", customerId: null };

  // limite por CPF e por tentativas globais: a tabela api_rate_limits ja
  // existia para as outras APIs publicas, e o portal reusa o mesmo mecanismo
  const bucket = `portal-login:${cpfDig}`;
  const janela = await rateLimit(bucket, 10, 300).catch(() => true);
  const global = await rateLimit("portal-login", 120, 60).catch(() => true);
  if (!janela || !global) {
    return { erro: "Muitas tentativas. Aguarde alguns minutos e tente novamente.", customerId: null };
  }

  const c = await one<any>(
    `SELECT id, name, active, portal_password_hash
       FROM customers
      WHERE replace(replace(replace(replace(replace(doc,'.',''),'-',''),'(',''),')',''),' ','') = ? AND active = 1`,
    [cpfDig],
  );
  // cliente que nunca ativou o portal cai no mesmo erro de senha errada:
  // a mensagem nao revela quais CPFs tem acesso
  if (!c || !c.portal_password_hash || !verificaSenhaCliente(password, c.portal_password_hash)) {
    return { erro: "CPF ou senha inválidos.", customerId: null };
  }

  return { erro: null, customerId: c.id };
}

/** Formato simples usado pela acao de login e pelos testes. */
export async function loginCliente(cpf: string, password: string): Promise<string | null> {
  return (await tentarLogin(cpf, password)).erro;
}

/* ------------------------------ sessao ------------------------------ */

/** Abre a sessao do cliente. O cookie so e tocado em portal-auth.ts. */
export async function abrirSessaoCliente(customerId: number): Promise<string> {
  const id = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + 30 * 864e5);
  await insert(`INSERT INTO portal_sessions (id, customer_id, expires_at) VALUES (?,?,?)`, [
    id,
    customerId,
    expires.toISOString(),
  ]);
  return id;
}

/** Encerra uma sessao pelo id (o cookie e resolvido em portal-auth.ts). */
export async function apagarSessao(id: string) {
  await run(`DELETE FROM portal_sessions WHERE id = ?`, [id]);
}

/**
 * Cliente de uma sessao valida, ou null. Nao le cookie: quem chama passa o id.
 */
export async function clienteDaSessao(sessionId: string): Promise<{ id: number; name: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(sessionId)) return null;
  const row = await one<any>(
    `SELECT c.id, c.name, s.expires_at
       FROM portal_sessions s JOIN customers c ON c.id = s.customer_id
      WHERE s.id = ?`,
    [sessionId],
  );
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await apagarSessao(sessionId);
    return null;
  }
  return { id: row.id, name: String(row.name ?? "").trim() };
}

/** Limpeza de sessoes vencidas (mesma chamada da limpeza das sessoes internas). */
export async function purgeExpiredPortalSessions() {
  await run(`DELETE FROM portal_sessions WHERE expires_at < ?`, [new Date().toISOString()]);
}

/** Usado no teste: quantas sessoes abertas o cliente tem. */
export async function sessoesAbertasDe(customerId: number): Promise<number> {
  return await scalar<number>(`SELECT COUNT(*) FROM portal_sessions WHERE customer_id = ?`, [customerId]);
}
