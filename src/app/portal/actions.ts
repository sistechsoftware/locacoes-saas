"use server";
import { redirect } from "next/navigation";
import { entrarPortal, configurarAcesso, encerrarSessaoCliente } from "@/lib/portal-auth";

/** Login do portal: CPF + senha. Toda a regra fica em portal-core.ts. */
export async function portalLoginAction(_prev: string | null, formData: FormData): Promise<string | null> {
  const cpf = String(formData.get("cpf") ?? "");
  const senha = String(formData.get("password") ?? "");
  const erro = await entrarPortal(cpf, senha);
  if (erro) return erro;
  redirect("/portal");
}

/** Primeiro acesso (ou redefinicao): token + CPF + telefone + nova senha. */
export async function portalSetupAction(_prev: string | null, formData: FormData): Promise<string | null> {
  const r = await configurarAcesso({
    token: String(formData.get("token") ?? ""),
    cpf: String(formData.get("cpf") ?? ""),
    telefone: String(formData.get("telefone") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (!r.ok) return r.erro;
  redirect("/portal/login?feito=1");
}

/** Sair do portal: apaga a sessao do cliente e o cookie dela. */
export async function portalSairAction() {
  await encerrarSessaoCliente();
  redirect("/portal/login");
}
