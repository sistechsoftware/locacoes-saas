"use server";
import { headers } from "next/headers";
import { pedirRedefinicao } from "@/lib/recuperacao";
import { rateLimit } from "@/lib/rate-limit";

async function ipDaRequisicao(): Promise<string> {
  try {
    const h = await headers();
    return h.get("cf-connecting-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "desconhecido";
  } catch {
    return "desconhecido";
  }
}

/**
 * Estado = booleano: true quando o pedido foi processado (a tela troca o
 * formulário pela mensagem de sucesso SEMPRE — mesmo sem usuário existir).
 */
export async function pedirRedefinicaoAction(_prev: boolean, formData: FormData): Promise<boolean> {
  const ip = await ipDaRequisicao();
  // 3 pedidos por 15 min por IP: rota pública que dispara e-mail.
  const permitido = await rateLimit(`recuperar:${ip}`, 3, 900).catch(() => true);
  if (!permitido) return true; // resposta idêntica: não vira oráculo de rate limit

  await pedirRedefinicao({ username: String(formData.get("username") ?? "") });
  return true;
}
