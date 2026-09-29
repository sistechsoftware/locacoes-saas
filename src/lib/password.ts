import crypto from "node:crypto";

/**
 * Hash/verificação de senha fora do auth.ts.
 *
 * O auth.ts puxa next/headers e o guarda "server-only", o que impede qualquer
 * teste (node:test + FakeD1) e rotina fora de request de importar estas
 * funções. Mesma implementação de sempre (scrypt com salt aleatório, formato
 * `scrypt$salt$hash`): nada muda para quem já tem senha gravada.
 */

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}
