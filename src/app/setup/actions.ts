"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { criarPrimeiroOwner } from "@/lib/primeiro-acesso";
import { createSession } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { rateLimit } from "@/lib/rate-limit";

async function ipDaRequisicao(): Promise<string> {
  try {
    const h = await headers();
    return h.get("cf-connecting-ip") || h.get("x-forwarded-for")?.split(",")[0]?.trim() || "desconhecido";
  } catch {
    return "desconhecido";
  }
}

export async function setupAction(_prev: string | null, formData: FormData): Promise<string | null> {
  // Um totalizador de tentativas por IP: evita varredura do form de setup.
  const ip = await ipDaRequisicao().catch(() => "desconhecido");
  const permitido = await rateLimit(`setup:${ip}`, 10, 900).catch(() => true);
  if (!permitido) return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";

  const resultado = await criarPrimeiroOwner({
    empresa: String(formData.get("empresa") ?? ""),
    nome: String(formData.get("nome") ?? ""),
    username: String(formData.get("username") ?? ""),
    senha: String(formData.get("senha") ?? ""),
  });
  if (!resultado.ok) return resultado.erro;

  await createSession(resultado.userId);
  await logAction(
    { id: resultado.userId, name: "", username: "", role: "owner", company_id: 1, avatar_url: null, platform_admin: true },
    "setup",
    "usuario",
    resultado.userId,
    "Primeiro acesso configurado (proprietário criado)",
  );
  redirect("/dashboard");
}
