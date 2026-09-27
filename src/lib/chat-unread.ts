/**
 * Estado compartilhado do contador de mensagens nao lidas.
 *
 * IMPORTANTE: este arquivo NAO pode ter "use client".
 * Ele e importado pelo layout do servidor (para semear o primeiro quadro com
 * os contadores vindos do banco) e por componentes cliente (para ler o estado).
 * Se virasse referencia de cliente, chamar seedUnread() no servidor lancaria
 * "Attempted to call seedUnread() from the server" e derrubaria todas as paginas
 * autenticadas em producao — foi exatamente o bug corrigido aqui.
 *
 * Uma unica fonte de verdade para o sino do topo, o badge do menu inferior e
 * a tela do chat: os tres leem daqui, entao nunca divergem.
 *
 * O polling e centralizado e adaptativo:
 *  - consulta pesada so a endpoint leve /api/chat/unread (duas contas, sem
 *    lista de conversas nem usuarios);
 *  - ritmo rapido (4s) por 45s apos cada troca de rota — quando o usuario
 *    acaba de navegar, mensagem nova aparece quase em tempo real — e depois
 *    desacelera (15s) para nao gastar o banco em tela parada;
 *  - consulta imediata quando a aba volta a ficar visivel ou recebe foco;
 *  - pausa total com a aba em segundo plano;
 *  - o chat dispara o evento "chat:atualizado" ao ler/enviar mensagem e o
 *    contador reconsulta na hora, sem esperar o proximo ciclo.
 *
 * A contagem de "quem quer polling" (hold/release) evita timers duplicados:
 * nao importa quantos componentes usem o contador, existe no maximo um ciclo
 * ativo por pagina.
 *
 * O hook de leitura (useUnread) mora em @/lib/use-unread — arquivos com hook
 * precisam de "use client" e este modulo precisa ficar livre de React para
 * ser seguro de importar tanto no servidor quanto no cliente.
 */

export type UnreadState = {
  /** Total de mensagens nao lidas (badge numerico do topo e do menu). */
  unread: number;
  /** Quantas conversas tem pendencia (texto de apoio da tela do chat). */
  unreadConversations: number;
  /** Nao lidas por conversa, so as que tem pendencia. */
  conversations: { conversation_id: number; unread: number }[];
};

const RAPIDO_MS = 4_000;
const LENTO_MS = 15_000;
const JANELA_RAPIDA_MS = 45_000;

let state: UnreadState = { unread: 0, unreadConversations: 0, conversations: [] };
let initialized = false;

const listeners = new Set<() => void>();
let holders = 0;
let timeout: ReturnType<typeof setTimeout> | null = null;
let emVoo = false;
let token = 0;
let navegouEm = 0;

function mesmo(a: UnreadState, b: UnreadState) {
  return (
    a.unread === b.unread &&
    a.unreadConversations === b.unreadConversations &&
    a.conversations.length === b.conversations.length &&
    a.conversations.every(
      (c, i) => c.conversation_id === b.conversations[i].conversation_id && c.unread === b.conversations[i].unread,
    )
  );
}

function emitir() {
  for (const l of listeners) l();
}

/** Valor atual (para uso imperativo e snapshot do hook). */
export function getUnread(): UnreadState {
  return state;
}

/**
 * Enxerta valores conhecidos no servidor (primeiro quadro renderizado sem
 * consulta nenhuma) e os resultados das consultas do proprio chat. So emite
 * quando algo mudou de verdade, para nao renderizar em cascata.
 */
export function seedUnread(par: Partial<UnreadState>) {
  const novo: UnreadState = { ...state, ...par };
  if (initialized && mesmo(novo, state)) return;
  state = novo;
  initialized = true;
  emitir();
}

/** Consulta imediata ao endpoint leve. Usado pelo botao de retry e eventos. */
export function refreshUnread(): Promise<UnreadState> {
  return consultar();
}

async function consultar(): Promise<UnreadState> {
  if (emVoo) return state;
  emVoo = true;
  const meu = ++token;
  try {
    const res = await fetch("/api/chat/unread", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json().catch(() => ({}))) as Partial<UnreadState>;
    if (meu === token) {
      seedUnread({
        unread: data.unread ?? 0,
        unreadConversations: data.unreadConversations ?? 0,
        conversations: data.conversations ?? [],
      });
    }
  } catch {
    /* offline: mantem o ultimo valor conhecido */
  } finally {
    emVoo = false;
  }
  return state;
}

function tick() {
  timeout = null;
  void consultar();
  programar();
}

/** (Re)programa o ciclo com o ritmo adequado ao momento. */
function programar() {
  if (timeout) {
    clearTimeout(timeout);
    timeout = null;
  }
  if (holders === 0) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
  const periodo = Date.now() - navegouEm < JANELA_RAPIDA_MS ? RAPIDO_MS : LENTO_MS;
  timeout = setTimeout(tick, periodo);
}

function aoVisibilidade() {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "visible") {
    void consultar();
    navegouEm = Date.now(); // volta no ritmo rapido por um ciclo
  }
  programar();
}

function aoEvento() {
  void consultar();
  programar();
}

/** Enxerto imediato apos troca de rota ou acao do usuario. */
export function pokeUnread() {
  navegouEm = Date.now();
  if (initialized) void consultar();
  programar();
}

/**
 * Sinaliza que um componente da pagina usa o contador (idempotente).
 * So faz efeito no navegador: no servidor nao existe ciclo de polling.
 */
export function holdUnreadPolling() {
  if (typeof window === "undefined") return;
  holders++;
  if (holders === 1) {
    document.addEventListener("visibilitychange", aoVisibilidade);
    window.addEventListener("focus", aoEvento);
    window.addEventListener("chat:atualizado", aoEvento);
    if (!initialized) void consultar();
    programar();
  }
}

/** Libera a participacao do componente; encerra o ciclo quando o ultimo sai. */
export function releaseUnreadPolling() {
  if (typeof window === "undefined") return;
  holders = Math.max(0, holders - 1);
  if (holders === 0) {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    document.removeEventListener("visibilitychange", aoVisibilidade);
    window.removeEventListener("focus", aoEvento);
    window.removeEventListener("chat:atualizado", aoEvento);
  }
}

/** Usado pelo hook de leitura (use-unread); nao altere o contrato. */
export function subscrever(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

