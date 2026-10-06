import "server-only";
import { estadoAssinatura, type EstadoAssinatura } from "./billing";

/**
 * PENDÊNCIA #05 — o bloqueio de assinatura precisa valer no BACKEND.
 *
 * Até aqui `bloqueioDuro` só era consumido pelo layout: uma empresa suspensa
 * ou cancelada com sessão ativa continuava criando reservas, editando estoque
 * e lançando financeiro ao chamar as server actions diretamente (fetch
 * manual, formulário reenviado) — o gate de tela não roda nesse caminho.
 *
 * Este módulo é a ÚNICA política de bloqueio do sistema. Ele é aplicado nos
 * pontos de entrada compartilhados (auth.requireUser/requireCompanyContext e
 * api-security.apiUser), de modo que toda action e toda rota /api interna
 * herda a checagem sem repetir código — e uma action nova não tem como
 * esquecer o gate.
 *
 * Duas regras que fazem diferença:
 *
 *  1. `platform_admin` passa por cima (operador da plataforma não depende de
 *     assinatura de cliente — ele É a plataforma).
 *  2. FALHA DE LEITURA NÃO LIBERA. O gate antigo era fail-open
 *     (`.catch(() => null)` == liberado), ou seja, um erro na camada
 *     comercial abria a porta exatamente para a conta que deveria estar
 *     presa. Agora: leitura fresca sempre; se ela falhar, vale o ÚLTIMO
 *     ESTADO CONHECIDO dentro de uma janela curta (60s) — assim um erro
 *     transitório não derruba conta boa que estava funcionando um instante
 *     atrás; sem evidência recente (cache frio), o gate é conservador e
 *     BLOQUEIA. "Não abrir a porta" pesa mais que "não incomodar".
 */

export class AssinaturaBloqueadaError extends Error {
  constructor(
    message = "Assinatura da empresa bloqueada. Regularize o pagamento em Faturamento para continuar usando o sistema.",
  ) {
    super(message);
    this.name = "AssinaturaBloqueadaError";
  }
}

/** Quanto tempo o último estado lido com sucesso segue valendo como evidência. */
const FALLBACK_TTL_MS = 60_000;

/** Último estado lido com sucesso, por empresa (só é consultado em FALHA). */
const ultimoEstadoConhecido = new Map<number, { estado: EstadoAssinatura; em: number }>();

/** Limpa o cache (testes: cenarios de falha de leitura). */
export function resetCacheGateAssinatura() {
  ultimoEstadoConhecido.clear();
}

/**
 * Estado da assinatura para o gate.
 *
 * Sucesso -> grava no cache e devolve (leitura sempre fresca: suspender uma
 * conta é efeito imediato, nunca depende de cache). Falha -> devolve o último
 * estado conhecido enquanto for recente; sem evidência recente -> `null`
 * (desconhecido), que o gate trata como bloqueado.
 */
export async function estadoAssinaturaSeguro(companyId: number): Promise<EstadoAssinatura | null> {
  try {
    const estado = await estadoAssinatura(companyId);
    ultimoEstadoConhecido.set(companyId, { estado, em: Date.now() });
    return estado;
  } catch (e) {
    const cachado = ultimoEstadoConhecido.get(companyId);
    if (cachado && Date.now() - cachado.em <= FALLBACK_TTL_MS) return cachado.estado;
    // O erro fica visível (quem opera precisa saber que a leitura falhou),
    // mas ele NUNCA vira "liberado".
    console.error(`[assinatura-gate] falha ao ler assinatura da empresa ${companyId}:`, e);
    return null;
  }
}

/**
 * Lança `AssinaturaBloqueadaError` quando a empresa não pode operar.
 *
 * Chamado pelos pontos de entrada de sessão (requireUser/requireCompanyContext)
 * e pelas rotas /api internas (apiUser). Quem chama direto — testes e código
 * legado — pode continuar chamando esta função no topo da action.
 */
export async function exigirAssinaturaAtiva(user: {
  company_id: number;
  platform_admin: boolean | number;
}): Promise<void> {
  if (user.platform_admin) return;
  const estado = await estadoAssinaturaSeguro(user.company_id);
  if (!estado || estado.bloqueioDuro) {
    throw new AssinaturaBloqueadaError(
      !estado
        ? "Não foi possível confirmar a assinatura da empresa. Tente novamente em instantes."
        : `Assinatura da empresa bloqueada (${estado.rotulo}). Regularize o pagamento para continuar usando o sistema.`,
    );
  }
}
