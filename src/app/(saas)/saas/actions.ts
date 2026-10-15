"use server";
import { revalidatePath } from "next/cache";
import { assertPlatformAdmin } from "@/lib/auth";
import { acaoPlataforma, assinaturaDaEmpresa, listarPlanos, trocarPlano } from "@/lib/billing";
import { asaasClient, ASAAS_PRODUCAO, ASAAS_SANDBOX } from "@/lib/asaas";
import { credenciaisAsaas, gravarConfig, type ChavePlataforma } from "@/lib/platform-settings";
import { logAction } from "@/lib/audit";
import {
  aplicarAjustesRecursos,
  aplicarLimiteUsuarios,
  cancelarCortesia,
  criarCortesia,
  type EntradaAjuste,
  type EntradaCortesia,
  type ResultadoAdmin,
} from "@/lib/plano-personalizado";

export type AcaoResultado = { ok: boolean; mensagem: string };

/** Resultado da lib admin -> formato das telas (erro vira mensagem). */
const paraTela = (r: ResultadoAdmin): AcaoResultado => ({ ok: r.ok, mensagem: r.ok ? r.mensagem : r.erro });

/**
 * Define o plano de uma empresa (reconciliação do painel — decisão da
 * correção de planos). Empresas criadas antes do checkout público nasceram
 * com o primeiro plano do catálogo sem que ninguém escolhesse nada; aqui o
 * operador da plataforma corrige o plano registro a registro.
 *
 * Segurança: só platform_admin; o valor passa pela MESMA função de troca do
 * fluxo do cliente (trocarPlano valida slug ativo, recusa assinatura
 * cancelada e recalcula o período) — nenhum caminho paralelo de escrita — e
 * a mudança fica registrada em audit_logs.
 */
export async function definirPlanoAction(companyId: number, planSlug: string): Promise<AcaoResultado> {
  const admin = await assertPlatformAdmin();
  try {
    const antes = await assinaturaDaEmpresa(companyId);
    if (!antes) return { ok: false, mensagem: "Empresa sem assinatura registrada." };
    const planos = await listarPlanos();
    const destino = planos.find((p) => p.slug === planSlug);
    if (!destino) return { ok: false, mensagem: "Plano inexistente ou inativo." };
    await trocarPlano(companyId, planSlug);
    const origem = planos.find((p) => p.id === antes.plan_id)?.slug ?? "desconhecido";
    await logAction(
      admin,
      "plataforma.definir_plano",
      "subscription",
      companyId,
      `Plano da empresa ${companyId} definido como ${destino.name} (antes: ${origem})`,
    );
    revalidatePath("/saas/assinaturas");
    revalidatePath("/saas");
    return { ok: true, mensagem: `Plano definido como ${destino.name}.` };
  } catch (e: any) {
    return { ok: false, mensagem: e?.message ?? "Falha ao definir o plano." };
  }
}

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
/* Personalização de planos por empresa (migration 0039)                       */
/* -------------------------------------------------------------------------- */

/*
 * Toda a camada administrativa de funcionalidades, limites e cortesias vive
 * AQUI, atrás do mesmo guard das demais ações do painel: assertPlatformAdmin
 * (users.platform_admin = 1) lança PermissionError no servidor para qualquer
 * chamada direta — o admin de uma empresa cliente, operador, usuário comum ou
 * requisição manipulada nunca passam, independentemente da interface. Os
 * company_id recebidos são validados contra companies antes de qualquer
 * escrita, e o histórico fica em audit_logs com antes/depois.
 */

/**
 * Salva um LOTE de ajustes de funcionalidade da empresa (liberar/bloquear/
 * voltar ao padrão do plano) numa única operação atômica, sem tocar no plano
 * contratado, no preço ou na cobrança.
 */
export async function salvarRecursosEmpresaAction(
  companyId: number,
  entradas: EntradaAjuste[],
  motivo: string,
): Promise<AcaoResultado> {
  const admin = await assertPlatformAdmin();
  const r = await aplicarAjustesRecursos(admin, companyId, entradas, motivo);
  if (r.ok) {
    revalidatePath("/saas/empresas");
    revalidatePath(`/saas/empresas/${companyId}`);
    revalidatePath("/saas");
  }
  return paraTela(r);
}

/** Ajusta (ou remove) o limite de usuários individual da empresa. */
export async function salvarLimiteUsuariosAction(
  companyId: number,
  maxUsers: number | null,
  motivo: string,
): Promise<AcaoResultado> {
  const admin = await assertPlatformAdmin();
  const r = await aplicarLimiteUsuarios(admin, companyId, maxUsers, motivo);
  if (r.ok) {
    revalidatePath(`/saas/empresas/${companyId}`);
    revalidatePath("/saas/empresas");
  }
  return paraTela(r);
}

/** Concede uma cortesia (plano-referência + vigência) sem mudar a assinatura. */
export async function criarCortesiaAction(companyId: number, entrada: EntradaCortesia): Promise<AcaoResultado> {
  const admin = await assertPlatformAdmin();
  const r = await criarCortesia(admin, companyId, entrada);
  if (r.ok) {
    revalidatePath(`/saas/empresas/${companyId}`);
    revalidatePath("/saas/assinaturas");
  }
  return paraTela(r);
}

/** Cancela UMA cortesia antecipadamente (só os benefícios dela). */
export async function cancelarCortesiaAction(cortesiaId: number): Promise<AcaoResultado> {
  const admin = await assertPlatformAdmin();
  const r = await cancelarCortesia(admin, cortesiaId);
  if (r.ok) revalidatePath("/saas/empresas");
  return paraTela(r);
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
      const bruto = entrada[chave as keyof EntradaIntegracao];
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
 * Contato de suporte da plataforma (e-mail e WhatsApp) — exibido na tela de
 * assinatura BLOQUEADA e nos avisos de contato. São valores não-sensíveis
 * (TEXTOS de platform-settings), gravados em claro de propósito: o cliente
 * precisa deles para conseguir ajuda justamente quando não consegue entrar.
 * Só platform_admin; campo vazio na lista `limpar` apaga o canal.
 */
export async function salvarContatoSuporteAction(
  entrada: { suporte_email?: string; suporte_whatsapp?: string },
  limpar: ChavePlataforma[] = [],
): Promise<AcaoResultado> {
  const admin = await assertPlatformAdmin();
  const campos: ChavePlataforma[] = ["suporte_email", "suporte_whatsapp"];
  try {
    for (const chave of campos) {
      const bruto = entrada[chave as keyof typeof entrada];
      if (typeof bruto === "string" && bruto.trim()) {
        await gravarConfig(chave, bruto.trim());
      }
    }
    for (const chave of limpar) {
      if (!campos.includes(chave)) continue;
      await gravarConfig(chave, null);
    }
    await logAction(
      admin,
      "plataforma.contato_suporte",
      "platform_setting",
      null,
      "Contato de suporte atualizado pelo painel",
      { limpos: limpar },
    );
    revalidatePath("/saas/configuracoes");
    revalidatePath("/assinatura-bloqueada");
    return { ok: true, mensagem: "Contato de suporte salvo." };
  } catch (e: any) {
    return { ok: false, mensagem: e?.message ?? "Falha ao salvar o contato." };
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
