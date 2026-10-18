/**
 * Instrumentacao minima de desempenho (auditoria de CPU/latencia).
 *
 * Tres propositos, todos baratos o bastante para rodar em producao:
 *
 * 1. Contar IDAS AO D1 por invocacao (fetch ou cron) — o numero que domina a
 *    latencia, porque cada consulta e uma volta pela rede.
 * 2. Memo POR REQUISICAO: dentro da mesma invocacao, a mesma leitura (sessao,
 *    assinatura, ajustes de plano) nao se repete. ENTRE requisicoes nada e
 *    cacheado: cada request le fresco, entao suspender conta ou trocar plano
 *    continua efeito imediato.
 * 3. Marcar o inicio da invocacao para medir duracao total.
 *
 * FORA de uma invocacao (testes, scripts, cron sem o wrapper) nao ha contexto:
 * memoPorInvocacao vira passthrough e o comportamento e identico ao atual.
 *
 * IMPORTANTE: `ms` mede tempo DE PAREDE (inclui espera por rede/banco). CPU
 * time e outra metrica — ela vem do painel Cloudflare ("CPU Time per
 * execution" e Workers Logs), nunca deste log.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type ContextoInvocacao = {
  /** Idas ao D1 ja realizadas nesta invocacao (batch conta como 1 ida). */
  consultas: number;
  /** epoch ms do inicio da invocacao. */
  inicio: number;
  /** Memo de leituras repetidas dentro da invocacao. */
  memo: Map<string, Promise<unknown>>;
};

declare global {
  var __locoPerfAls: AsyncLocalStorage<ContextoInvocacao> | undefined;
}

/**
 * O OpenNext gera DOIS bundles (custom-worker e a funcao servidor do Next) e
 * cada um tem sua propria copia deste modulo. Sem o globalThis, o ALS do
 * worker nao seria o mesmo que db.ts enxergaria dentro do render — e toda
 * contagem viraria zero. No Worker (um isolate) o globalThis e compartilhado.
 */
const als: AsyncLocalStorage<ContextoInvocacao> =
  (globalThis.__locoPerfAls ??= new AsyncLocalStorage<ContextoInvocacao>());

/** Executa `fn` com contexto da invocacao (usado por fetch e scheduled). */
export function comContextoDeInvocacao<T>(fn: () => Promise<T>): Promise<T> {
  return als.run({ consultas: 0, inicio: Date.now(), memo: new Map() }, fn);
}

/** Contexto da invocacao atual, se houver. */
export function contextoAtual(): ContextoInvocacao | undefined {
  return als.getStore();
}

/**
 * Tipo/fábrica de AsyncLocalStorage para OUTROS módulos.
 *
 * `node:async_hooks` só é importado AQUI (perf.ts): quem precisa de um ALS
 * próprio — como o lote de leituras de db.ts — usa estas duas exports. O
 * motivo é o build do Next: cada `import "node:async_hooks"` em arquivo de
 * rota/render vira um aviso "not supported in the Edge Runtime" (o worker
 * roda com nodejs_compat e o módulo funciona; o gráfico de módulos não muda,
 * perf.ts já o carrega — era só ruído duplicado).
 */
export type MemoriaAsync<T> = AsyncLocalStorage<T>;

export function novaMemoriaAsync<T>(): AsyncLocalStorage<T> {
  return new AsyncLocalStorage<T>();
}

/** Registra uma ida ao D1. Chamado pelos helpers de db.ts. */
export function marcarConsulta(): void {
  const ctx = als.getStore();
  if (ctx) ctx.consultas++;
}

/**
 * Memo de leitura por invocacao.
 *
 * `calcular` executa UMA vez por chave dentro da mesma requisicao; quem chama
 * em paralelo compartilha a mesma promise (nenhuma corrida, nenhuma leitura
 * extras). Sem contexto de invocacao (testes, scripts), executa sempre —
 * passthrough puro, sem cache entre chamadas.
 */
export function memoPorInvocacao<T>(chave: string, calcular: () => Promise<T>): Promise<T> {
  const ctx = als.getStore();
  if (!ctx) return calcular();
  const existente = ctx.memo.get(chave);
  if (existente) return existente as Promise<T>;
  const promessa = calcular();
  ctx.memo.set(chave, promessa);
  return promessa;
}
