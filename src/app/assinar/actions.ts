"use server";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { criarEmpresaComTrial } from "@/lib/onboarding";
import { createSession, destinoAposLogin } from "@/lib/auth";
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

/** Origem da requisição para montar links de e-mail ('' fora de request). */
async function baseUrl(): Promise<string | null> {
  try {
    const h = await headers();
    const host = h.get("x-forwarded-host") || h.get("host") || "";
    const proto = h.get("x-forwarded-proto") || "https";
    return host ? `${proto}://${host}` : null;
  } catch {
    return null;
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
    email: String(formData.get("email") ?? ""),
  });
  if (!resultado.ok) return resultado.erro;

  // Já entra: o trial nasceu, o sistema está utilizável imediatamente.
  await createSession(resultado.userId);

  // Boas-vindas — fail-open: se falhar, o cadastro segue íntegro.
  const { emailBoasVindas, enviarEmail } = await import("@/lib/email");
  void enviarEmail({
    to: resultado.email,
    subject: "Bem-vindo(a) à Lima's Locações",
    html: emailBoasVindas(resultado.nome, resultado.empresa, resultado.trialEndsAt, (await baseUrl()) ?? ""),
    text: `Conta criada! Trial até ${resultado.trialEndsAt}. Entre em ${await baseUrl() ?? ""}/login.`,
  }).catch(() => false);

  // Auditoria com company_id da NOVA empresa (null no campo user, porque a
  // sessão do logAction ainda não existe; os dados de rede vêm do headers).
  await logAction(
    null,
    "onboarding",
    "company",
    resultado.companyId,
    `Nova empresa via checkout (empresa #${resultado.companyId}, trial até ${resultado.trialEndsAt})`,
  );

  redirect(destinoAposLogin({ platform_admin: false })); // cliente nasce como locador
}
