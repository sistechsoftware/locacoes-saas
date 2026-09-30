"use server";
import { revalidatePath } from "next/cache";
import { requireUser, PermissionError } from "@/lib/auth";
import { gerarCobrancaPeriodo, trocarPlano } from "@/lib/billing";
import { logAction } from "@/lib/audit";

/**
 * Gera a cobrança PIX do próximo período.
 *
 * Somente owner da empresa. Sem Asaas configurado devolve uma mensagem
 * acionável em vez de explodir — a tela mostra o erro e o sistema segue.
 */
export async function gerarCobrancaAction(): Promise<{ ok: boolean; mensagem: string; url?: string }> {
  const user = await requireUser();
  if (user.role !== "owner") throw new PermissionError("Somente o proprietário pode gerar cobranças.");

  const r = await gerarCobrancaPeriodo(user.company_id);
  if (r.ok) {
    await logAction(user, "billing.gerar_cobranca", "subscription", user.company_id,
      `Cobrança PIX gerada (venc. ${r.dueDate})`);
    revalidatePath("/faturamento");
    return { ok: true, mensagem: `Cobrança gerada — vencimento ${r.dueDate.split("-").reverse().join("/")}.`, url: r.invoiceUrl ?? undefined };
  }
  const motivos: Record<string, string> = {
    asaas_nao_configurado: "Cobrança ainda não configurada na plataforma (Asaas ausente). Fale com o suporte.",
    sem_empresa: "Empresa não encontrada ou inativa.",
    sem_dados_bancarios: "Não foi possível gerar a cobrança agora. Tente novamente.",
  };
  // Detalhe técnico (quando o Asaas devolveu erro) ajuda o suporte a
  // diagnosticar sem precisar de tail/stack — a mensagem vem da API deles.
  const detalhe = "erro" in r && r.erro ? ` (detalhe: ${r.erro})` : "";
  return { ok: false, mensagem: `${motivos[r.motivo] ?? "Falha ao gerar a cobrança."}${detalhe}`, url: undefined };
}

export async function trocarPlanoAction(slug: string): Promise<{ ok: boolean; mensagem: string }> {
  const user = await requireUser();
  if (user.role !== "owner") throw new PermissionError("Somente o proprietário pode trocar o plano.");
  try {
    await trocarPlano(user.company_id, slug);
    await logAction(user, "billing.trocar_plano", "subscription", user.company_id, `Plano alterado para ${slug}`);
    revalidatePath("/faturamento");
    return { ok: true, mensagem: "Plano atualizado." };
  } catch (e: any) {
    return { ok: false, mensagem: e?.message ?? "Não foi possível trocar o plano." };
  }
}
