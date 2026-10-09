/**
 * Localização de conta por IDENTIFICADOR (CPF, CNPJ, e-mail ou usuário legado).
 *
 * Sem next/* (mesmo contrato de recuperacao.ts/usuarios.ts): a lógica roda em
 * testes com FakeD1 e em qualquer server action.
 *
 * Regras de segurança:
 *  * a resposta é sempre "conta ou nada" — nunca diz qual parte falhou;
 *  * identificador ambíguo (e-mail legado duplicado, por exemplo) devolve
 *    NENHUMA conta em vez de escolher uma ao acaso: ninguém acessa a conta de
 *    outra pessoa por causa de dado legado duplicado;
 *  * contas novas não nascem ambíguas: unicidade de documento é imposta pelo
 *    índice parcial da migração 0037 e de e-mail pela checagem em todos os
 *    caminhos de criação/edição.
 */

import { all, one } from "./db";
import { classificarIdentificador, normalizarEmail, type TipoIdentificador } from "./identidade";
import type { Role } from "./roles";

/** Linha completa de users — login usa senha/flag, recuperação usa e-mail. */
export type Conta = {
  id: number;
  name: string;
  username: string;
  email: string | null;
  password_hash: string;
  role: Role;
  active: number;
  company_id: number;
  avatar_url: string | null;
  platform_admin: number;
  person_type: "pf" | "pj" | null;
  document: string | null;
};

const COLUNAS = `id, name, username, email, password_hash, role, active, company_id,
                 avatar_url, platform_admin, person_type, document`;

/**
 * Localiza a conta a partir de qualquer identificador de login/recuperação.
 *
 * Ordem da classificação (identidade.ts): "@" -> e-mail; 11/14 dígitos ->
 * documento; o resto -> usuário legado. No caminho de documento, se nada
 * existir com aquele número, cai no usuário legado (compatibilidade com
 * usernames numéricos de 11/14 dígitos) — a senha continua sendo a barreira.
 */
export async function localizarConta(identificador: unknown): Promise<Conta | null> {
  const { tipo, valor } = classificarIdentificador(identificador);
  if (!valor) return null;

  if (tipo === "email") {
    const linhas = await all<Conta>(`SELECT ${COLUNAS} FROM users WHERE lower(email) = ?`, [valor]);
    // 0 ou 2+ = nada (ambiguidade nunca vira login).
    return linhas.length === 1 ? linhas[0] : null;
  }

  if (tipo === "documento") {
    const linhas = await all<Conta>(`SELECT ${COLUNAS} FROM users WHERE document = ?`, [valor]);
    if (linhas.length === 1) return linhas[0];
    if (linhas.length > 1) return null; // dado legado corrompido: não escolhe ao acaso
    // Fallback de compatibilidade: username que é só esses dígitos.
  }

  return (await one<Conta>(`SELECT ${COLUNAS} FROM users WHERE lower(username) = ?`, [valor])) ?? null;
}

/** E-mail já gravado em alguma conta (opcionalmente fora da própria). */
export async function emailJaUsado(email: unknown, excetoUserId?: number): Promise<boolean> {
  const normalizado = normalizarEmail(email);
  if (!normalizado) return false;
  const linha = await one<{ id: number }>(
    `SELECT id FROM users WHERE lower(email) = ? AND id <> ? LIMIT 1`,
    [normalizado, excetoUserId ?? -1],
  );
  return !!linha;
}

/**
 * Documento já gravado em alguma conta. A unicidade REAL é o índice parcial
 * único da migração 0037 (barreira contra cadastros simultâneos); esta checagem
 * existe para devolver uma mensagem clara antes do INSERT estourar.
 */
export async function documentoJaUsado(documento: unknown, excetoUserId?: number): Promise<boolean> {
  const doc = String(documento ?? "").replace(/\D/g, "");
  if (!doc) return false;
  const linha = await one<{ id: number }>(
    `SELECT id FROM users WHERE document = ? AND id <> ? LIMIT 1`,
    [doc, excetoUserId ?? -1],
  );
  return !!linha;
}

export type { TipoIdentificador };
