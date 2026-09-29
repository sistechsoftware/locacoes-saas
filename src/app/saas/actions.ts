"use server";
import { revalidatePath } from "next/cache";
import { assertPlatformAdmin } from "@/lib/auth";
import { acaoPlataforma } from "@/lib/billing";
import { logAction } from "@/lib/audit";

export type AcaoResultado = { ok: boolean; mensagem: string };

export async function acaoPlataformaAction(
  companyId: number,
  acao: "suspender" | "reativar" | "cancelar" | "reativar_trial",
): Promise<AcaoResultado> {
  const admin = await assertPlatformAdmin();
  try {
    await acaoPlataforma(companyId, acao);
    await logAction(admin, `plataforma.${acao}`, "subscription", companyId, `Ação da plataforma: ${acao} (empresa ${companyId})`);
    revalidatePath("/saas");
    return { ok: true, mensagem: "Ação aplicada." };
  } catch (e: any) {
    return { ok: false, mensagem: e?.message ?? "Falha na ação." };
  }
}
