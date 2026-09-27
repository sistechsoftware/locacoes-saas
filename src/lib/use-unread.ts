"use client";

import { useSyncExternalStore } from "react";
import { getUnread, subscrever, type UnreadState } from "@/lib/chat-unread";

/**
 * Hook de leitura do contador compartilhado de mensagens nao lidas.
 *
 * Vive em arquivo proprio com "use client": o estado (chat-unread.ts) precisa
 * ficar livre de diretivas e de React para poder ser importado pelo layout do
 * servidor (que semeia o primeiro quadro) sem virar referencia de cliente.
 */
export function useUnread(): UnreadState {
  return useSyncExternalStore(subscrever, getUnread, getUnread);
}
