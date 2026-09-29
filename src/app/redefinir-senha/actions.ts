"use server";
import { headers } from "next/headers";
import { aplicarRedefinicao } from "@/lib/recuperacao";
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
 * "OK" no estado = sucesso (o formulário redireciona via router).
 * A confirmação é conferida aqui, além do minlength do campo.
 */
export async function redefinirAction(_prev: string | null, formData: FormData): Promise<string | null> {
  const ip = await ipDaRequisicao();
  // Tokens são únicos, mas o endpoint é público: trava varredura de tokens.
  const permitido = await rateLimit(`redefinir:${ip}`, 10, 900).catch(() => true);
  if (!permitido) return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";

  const senha = String(formData.get("senha") ?? "");
  const confirmacao = String(formData.get("confirmacao") ?? "");
  if (senha !== confirmacao) return "As senhas não conferem.";

  const r = await aplicarRedefinicao({
    token: String(formData.get("token") ?? ""),
    senha,
  });
  return r.ok ? "OK" : r.erro;
}
