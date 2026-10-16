/**
 * Estado global de "ha uma acao do servidor em andamento" (auditoria de
 * percepcao de lentidao).
 *
 * PROBLEMA: uma server action lenta (varias idas ao D1 + re-render da pagina
 * inteira dentro do POST) so mudava o texto do botao para "Aguarde...". No
 * staging, medido na auditoria, cada requisicao custa ~0,45s fixos antes de
 * qualquer consulta e o detalhe de reserva roda 39 consultas — entao o clique
 * parecia "nao capturado" e o usuario atualizava a pagina no escuro.
 *
 * SOLUCAO: barra fixa no topo enquanto QUALQUER botao do app estiver
 * enviando um formulario. Cobertura de todo o app sem tocar em regra de
 * negocio: e so percepcao.
 *
 * ESTADO EM MODULO PURO, sem React no escopo do modulo (mesmo padrao de
 * chat-unread.ts): os testes rodam com `--conditions=react-server`, onde
 * createContext/useState nao existem — importar este arquivo de qualquer
 * pagina precisa ser inofensivo. Quem renderiza assina via
 * useSyncExternalStore (ProgressoAcoes.tsx).
 */
let pendentes = 0;
const ouvintes = new Set<() => void>();

/** Quantos forms do app estao enviando agora (0 = barra some). */
export function progressoPendentes(): number {
  return pendentes;
}

/** Entra (true) ou sai (false) do estado de envio. Seguro para chamar com 0. */
export function registrarProgresso(pendente: boolean): void {
  const novo = Math.max(0, pendentes + (pendente ? 1 : -1));
  if (novo === pendentes) return;
  pendentes = novo;
  for (const ouvinte of ouvintes) ouvinte();
}

/** Inscricao para useSyncExternalStore. Devolve a funcao de cancelamento. */
export function assinarProgresso(ouvinte: () => void): () => void {
  ouvintes.add(ouvinte);
  return () => {
    ouvintes.delete(ouvinte);
  };
}
