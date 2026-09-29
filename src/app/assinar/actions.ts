"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { criarEmpresaComTrial } from "@/lib/onboarding";
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

export async function criarEmpresaAction(_prev: string | null, formData: FormData): Promise<string | null> {
  // Bucket por IP mais apertado que o setup: rota aberta cria banco de dados.
  const ip = await ipDaRequisicao();
  const permitido = await rateLimit(`assinar:${ip}`, 5, 900).catch(() => true);
  if (!permitido) return "Muitas tentativas. Aguarde alguns minutos e tente novamente.";

  const resultado = await criarEmpresaComTrial({
    empresa: String(formData.get("empresa") ?? ""),
    nome: String(formData.get("nome") ?? ""),
    username: String(formData.get("username") ?? ""),
    senha: String(formData.get("senha") ?? ""),
    plano: String(formData.get("plano") ?? ""),
  });
  if (!resultado.ok) return resultado.erro;

  // Já entra: o trial nasceu, o sistema está utilizável imediatamente.
  await createSession(resultado.userId);

  // Auditoria com company_id da NOVA empresa (null no campo user, porque a
  // sessão do logAction ainda não existe; os dados de rede vêm do headers).
  await logAction(
    null,
    "onboarding",
    "company",
    resultado.companyId,
    `Nova empresa via checkout (empresa #${resultado.companyId}, trial até ${resultado.trialEndsAt})`,
  );

  redirect("/dashboard");
}
