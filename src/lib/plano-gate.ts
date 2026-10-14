import "server-only";
import { redirect } from "next/navigation";
import { estadoAssinaturaSeguro } from "./assinatura-gate";
import { RECURSOS, type PlanoSlug, type Recurso } from "./planos";
import { recursoLiberado } from "./plano-personalizado";
import type { Module } from "./roles";

/**
 * GATE DE RECURSOS CONTRATADOS (Etapa 4 da correção de planos).
 *
 * Antes disto NÃO existia nenhuma verificação de plano em lugar nenhum: o
 * menu renderizava tudo, `requireModule` só conferia PAPEL e as rotas /api
 * só sessão — qualquer plano com assinatura em dia usava portal, chat,
 * fidelidade, relatórios, fretes e contratos. Este módulo é a política
 * central aplicada nos mesmos pontos de entrada do gate de assinatura:
 *
 *  * páginas  -> requireModule() redireciona para /plano-restrito;
 *  * actions  -> requireModuleEdit() lança RecursoNaoContratadoError;
 *  * /api     -> apiUser() devolve 403 com `code: "recurso_nao_contratado"`;
 *  * portal   -> requireCliente()/rotas /api/portal barram na própria porta.
 *
 * Princípios:
 *  * o plano vem SEMPRE da assinatura da empresa autenticada (company_id do
 *    servidor), nunca de valor enviado pelo navegador;
 *  * FALHA DE LEITURA NÃO LIBERA: reutiliza estadoAssinaturaSeguro (leitura
 *    fresca; em falha, só o último estado conhecido de até 60s — sem
 *    evidência recente o plano fica desconhecido e o recurso pago BLOQUEIA);
 *  * recursos FUNDAMENTAIS (reservas, clientes, estoque, financeiro,
 *    orçamentos e tudo que não é item pago da oferta) nunca passam por esta
 *    checagem — o gate não pode virar trava de recursos que todo plano tem;
 *  * `platform_admin` passa por cima, igual ao gate de assinatura: o operador
 *    da plataforma não é cliente e não depende de plano de cliente;
 *  * os papéis internos (roles.ts) seguem INDEPENDENTES do plano: plano
 *    decide o quê existe para a empresa, papel decide quem pode mexer.
 */

export class RecursoNaoContratadoError extends Error {
  readonly recurso: Recurso;
  constructor(recurso: Recurso) {
    super(
      `O recurso "${RECURSOS[recurso].nome}" não está incluído no plano atual da empresa. ` +
        `Faça upgrade em Assinatura para liberar.`,
    );
    this.name = "RecursoNaoContratadoError";
    this.recurso = recurso;
  }
}

/**
 * Módulo interno -> recurso comercial. Só módulos PAGOS entram aqui; todo o
 * resto é fundamental e nem passa pela checagem.
 */
const RECURSO_DO_MODULO: Partial<Record<Module, Recurso>> = {
  chat: "chat",
  fidelidade: "fidelidade",
  relatorios: "relatorios",
  fretes: "fretes",
  contratos: "contratos",
};

export function recursoDoModulo(module: Module): Recurso | null {
  return RECURSO_DO_MODULO[module] ?? null;
}

/** Quem está sujeito à matriz de planos (empresa autenticada). */
export type SujetoDoPlano = { company_id: number; platform_admin: boolean | number };

/**
 * Plano vigente da empresa, resolvido na assinatura (fonte confiável).
 * `null` = não foi possível confirmar o plano (sem assinatura, sem plano no
 * catálogo ou falha de leitura) — e aí só recursos fundamentais seguem abertos.
 */
export async function planoDaEmpresa(companyId: number): Promise<PlanoSlug | null> {
  const estado = await estadoAssinaturaSeguro(companyId);
  const slug = estado?.plano?.slug;
  return typeof slug === "string" ? (slug as PlanoSlug) : null;
}

/**
 * A empresa (ou o operador da plataforma) pode usar o recurso agora?
 *
 * Personalização por empresa (painel /saas, migration 0039): a resolução
 * passou a considerar as camadas administrativas — bloqueio individual
 * (prevalece até sobre fundamental), liberação permanente e cortesia vigente
 * — pela precedência central de planos.ts (resolverPermissao). O plano vem
 * sempre da assinatura gravada no servidor; nenhuma personalização troca
 * plano, preço ou período. Sem personalização, o resultado é EXATAMENTE o
 * antigo (planoInclui fail-closed).
 */
export async function temRecurso(sujeto: SujetoDoPlano, recurso: Recurso): Promise<boolean> {
  if (sujeto.platform_admin) return true;
  return await recursoLiberado(sujeto.company_id, recurso);
}

/**
 * Observabilidade (Etapa 10): toda negação fica visível para quem opera,
 * identificando empresa, recurso e porta — sem PII, senha, token ou dado de
 * pagamento nos logs. "Recurso negado" NUNCA é tratado como autorização
 * válida: é só o rastro da porta que fechou.
 */
export function registrarNegacao(companyId: number, recurso: Recurso, via: string): void {
  console.warn(`[plano-gate] recurso negado (${via}): empresa=${companyId} recurso=${recurso}`);
}

/** Modo backend de ação: registra e lança (a action nada grava). */
export async function exigirRecurso(
  sujeto: SujetoDoPlano,
  recurso: Recurso,
  via = "action",
): Promise<void> {
  if (await temRecurso(sujeto, recurso)) return;
  registrarNegacao(sujeto.company_id, recurso, via);
  throw new RecursoNaoContratadoError(recurso);
}

/** Modo página: registra e manda para a tela explicativa (contextual, discreto). */
export function bloquearRecurso(
  recurso: Recurso,
  sujeto?: { company_id: number },
  via = "pagina",
): never {
  if (sujeto) registrarNegacao(sujeto.company_id, recurso, via);
  redirect(`/plano-restrito?recurso=${recurso}`);
}

/** Resposta padrão das rotas /api para recurso fora do plano (403, sem vazar internals). */
export function respostaRecursoNaoContratado(
  recurso: Recurso,
  sujeto?: { company_id: number },
  via = "api",
): Response {
  if (sujeto) registrarNegacao(sujeto.company_id, recurso, via);
  return Response.json(
    {
      error: `O recurso "${RECURSOS[recurso].nome}" não está incluído no plano atual da empresa.`,
      code: "recurso_nao_contratado",
    },
    { status: 403 },
  );
}
