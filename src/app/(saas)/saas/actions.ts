"use server";
import { revalidatePath } from "next/cache";
import { assertPlatformAdmin } from "@/lib/auth";
import { acaoPlataforma } from "@/lib/billing";
import { asaasClient, ASAAS_PRODUCAO, ASAAS_SANDBOX } from "@/lib/asaas";
import { credenciaisAsaas, gravarConfig, type ChavePlataforma } from "@/lib/platform-settings";
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

/* -------------------------------------------------------------------------- */
/* Integração Asaas — cadastro pelo painel (pendência: ativação em produção)   */
/* -------------------------------------------------------------------------- */

export type EntradaIntegracao = {
  asaas_api_key?: string;
  asaas_environment?: string;
  asaas_webhook_token?: string;
};

/**
 * Salva as credenciais do Asaas cadastradas pelo painel.
 *
 * Regras de segurança:
 *  * só platform_admin (assertPlatformAdmin — lança, não redireciona);
 *  * o valor NUNCA volta para o cliente nem entra no audit log (só o NOME do
 *    campo e o fato de ter sido gravado);
 *  * campo vazio = mantém o que já existe (para apagar, use limparCampo);
 *  * segredos são cifrados por platform-settings antes de irem ao banco.
 */
export async function salvarIntegracaoAsaasAction(
  entrada: EntradaIntegracao,
  limpar: ChavePlataforma[] = [],
): Promise<AcaoResultado> {
  const admin = await assertPlatformAdmin();
  const campos: ChavePlataforma[] = ["asaas_api_key", "asaas_environment", "asaas_webhook_token"];

  try {
    for (const chave of campos) {
      const bruto = entrada[chave];
      if (typeof bruto === "string" && bruto.trim()) {
        await gravarConfig(chave, bruto.trim());
      }
    }
    for (const chave of limpar) {
      if (!campos.includes(chave)) continue;
      await gravarConfig(chave, null);
    }

    const depois = await credenciaisAsaas();
    await logAction(
      admin,
      "plataforma.integracao_asaas",
      "platform_setting",
      null,
      "Credenciais do Asaas atualizadas pelo painel",
      {
        // Auditoria do QUE mudou — nunca o valor em si.
        ambiente: depois.environment ?? "ausente",
        tem_api_key: !!depois.apiKey,
        tem_webhook_token: !!depois.webhookToken,
        origem: depois.origem,
        limpos: limpar,
      },
    );
    revalidatePath("/saas/configuracoes");
    return { ok: true, mensagem: "Integração salva." };
  } catch (e: any) {
    return { ok: false, mensagem: e?.message ?? "Falha ao salvar a integração." };
  }
}

/**
 * Testa a credencial do Asaas contra a API real (sandbox ou produção, conforme
 * o ambiente resolvido). Não grava nada — só prova se a chave funciona.
 */
export async function testarIntegracaoAsaasAction(): Promise<
  AcaoResultado & { status?: number }
> {
  await assertPlatformAdmin();
  const cred = await credenciaisAsaas();
  if (!cred.apiKey) {
    return { ok: false, mensagem: "Nenhuma API key configurada (nem no Worker, nem no painel)." };
  }
  const producao = cred.environment === "production";
  const client = asaasClient({
    apiKey: cred.apiKey,
    baseUrl: producao ? ASAAS_PRODUCAO : ASAAS_SANDBOX,
  });
  const r = await client.testarCredencial();
  const rotulo = producao ? "produção" : "sandbox";
  return {
    ok: r.ok,
    status: r.status,
    mensagem: r.ok ? `Ambiente ${rotulo}: ${r.mensagem}` : `${rotulo}: ${r.mensagem}`,
  };
}
