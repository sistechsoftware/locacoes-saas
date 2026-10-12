"use server";
import { revalidatePath } from "next/cache";
import { requireModuleEdit, PermissionError } from "@/lib/auth";
import { dadosPagamentoCobranca, gerarCobrancaPeriodo, trocarPlano, type DadosPagamento } from "@/lib/billing";
import { ehMeioCobranca, type MeioCobranca } from "@/lib/asaas";
import { logAction } from "@/lib/audit";

/** Rótulos de auditoria por meio (sem expor nada sensível). */
const ROTULO_MEIO: Record<MeioCobranca, string> = {
  UNDEFINED: "fatura (pagador escolhe)",
  PIX: "PIX",
  BOLETO: "boleto",
  CREDIT_CARD: "cartão de crédito",
};

/**
 * Gera a cobrança do próximo período.
 *
 * `meio` é opcional e vem do seletor da tela: UNDEFINED (padrão — a fatura
 * do Asaas deixa o pagador escolher entre os meios habilitados na conta),
 * PIX, BOLETO ou CREDIT_CARD. Valor desconhecido é recusado no servidor
 * (nunca passa direto para o Asaas).
 *
 * Somente owner da empresa. Sem Asaas configurado devolve uma mensagem
 * acionável em vez de explodir — a tela mostra o erro e o sistema segue.
 */
export async function gerarCobrancaAction(meio?: string): Promise<{
  ok: boolean;
  mensagem: string;
  url?: string;
  bankSlipUrl?: string;
  linhaDigitavel?: string;
  billingType?: string;
}> {
  // Pendência #05: a ÚNICA action que não pode ser barrada pelo gate — ela é
  // o botão "gerar cobrança" da tela /assinatura-bloqueada, o caminho de
  // recuperação da própria conta bloqueada. Bloqueá-la trancaria a porta por
  // dentro. A exceção é listada em teste estático (bloqueio: "ignorar").
  const { user } = await requireModuleEdit("assinatura", { bloqueio: "ignorar" });
  if (user.role !== "owner") throw new PermissionError("Somente o proprietário pode gerar cobranças.");

  if (meio !== undefined && !ehMeioCobranca(meio)) {
    return { ok: false, mensagem: "Meio de pagamento inválido." };
  }

  const r = await gerarCobrancaPeriodo(user.company_id, meio !== undefined ? { meio } : {});
  if (r.ok) {
    await logAction(user, "billing.gerar_cobranca", "subscription", user.company_id,
      `Cobrança gerada — ${ROTULO_MEIO[r.billingType as MeioCobranca] ?? r.billingType} (venc. ${r.dueDate})${r.reutilizada ? " — já existia, reutilizada" : ""}`);
    revalidatePath("/faturamento");
    const quando = r.dueDate.split("-").reverse().join("/");
    return {
      ok: true,
      mensagem: r.reutilizada
        ? `Já existe uma cobrança em aberto para este período — vencimento ${quando}.`
        : `Cobrança gerada — vencimento ${quando}.`,
      url: r.invoiceUrl ?? undefined,
      bankSlipUrl: r.bankSlipUrl ?? undefined,
      linhaDigitavel: r.linhaDigitavel ?? undefined,
      billingType: r.billingType,
    };
  }
  const motivos: Record<string, string> = {
    asaas_nao_configurado: "Cobrança ainda não configurada na plataforma (Asaas ausente). Fale com o suporte.",
    sem_empresa: "Empresa não encontrada ou inativa.",
    sem_dados_bancarios: "Não foi possível gerar a cobrança agora. Tente novamente.",
    documento_invalido:
      "Cadastre o CNPJ/CPF da empresa em Configurações (aba Empresa) para gerar cobranças.",
    meio_invalido: "Meio de pagamento inválido.",
  };
  // Detalhe técnico (quando o Asaas devolveu erro) ajuda o suporte a
  // diagnosticar sem precisar de tail/stack — a mensagem vem da API deles.
  const detalhe = "erro" in r && r.erro ? ` (detalhe: ${r.erro})` : "";
  return { ok: false, mensagem: `${motivos[r.motivo] ?? "Falha ao gerar a cobrança."}${detalhe}` };
}

/**
 * Consulta os dados de pagamento (fatura, boleto/PDF+linha digitável, Pix
 * QR/copia-e-cola) de UMA cobrança da empresa logada.
 *
 * O isolamento é garantido na camada de dados (id + company_id); aqui só o
 * owner consulta. Nenhum segredo é retornado — apenas dados de pagamento já
 * visíveis ao pagador na fatura do Asaas.
 */
export async function dadosPagamentoAction(pagamentoId: number): Promise<
  { ok: true; dados: DadosPagamento } | { ok: false; mensagem: string }
> {
  const { user } = await requireModuleEdit("assinatura");
  if (user.role !== "owner") throw new PermissionError("Somente o proprietário pode consultar cobranças.");
  if (!Number.isInteger(pagamentoId) || pagamentoId <= 0) {
    return { ok: false, mensagem: "Cobrança inválida." };
  }
  const dados = await dadosPagamentoCobranca(user.company_id, pagamentoId);
  if (!dados) return { ok: false, mensagem: "Cobrança não encontrada ou indisponível." };
  return { ok: true, dados };
}

export async function trocarPlanoAction(slug: string): Promise<{ ok: boolean; mensagem: string }> {
  const { user } = await requireModuleEdit("assinatura");
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
