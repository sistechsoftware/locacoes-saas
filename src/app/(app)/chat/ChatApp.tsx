"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icons";
import Avatar from "@/components/Avatar";
import { holdUnreadPolling, releaseUnreadPolling, seedUnread } from "@/lib/chat-unread";
import { useUnread } from "@/lib/use-unread";

/* --------------------------------- tipos -------------------------------- */

type User = { id: number; name: string; username: string; role: string; avatar_url: string | null };
type Conversation = {
  conversation_id: number;
  other_id: number;
  other_name: string;
  other_username: string;
  other_avatar_url: string | null;
  last_message_id: number;
  last_body: string | null;
  last_kind: string;
  last_sender_id: number | null;
  last_created_at: string | null;
  unread: number;
  archived: number;
};
type Message = {
  id: number;
  conversation_id: number;
  sender_id: number;
  body: string | null;
  kind: string;
  file_id: string | null;
  file_name: string | null;
  file_mime: string | null;
  file_size: number | null;
  audio_seconds: number | null;
  duration_ms: number | null;
  read_at: string | null;
  deleted_at: string | null;
  created_at: string;
  /** Foto do remetente, resolvida no servidor junto com as mensagens. */
  sender_avatar_url?: string | null;
  mine?: boolean;
  /** estado otimista: "sending" | "error" */
  local?: string;
  localId?: string;
  file?: File;
};

type Props = {
  me: { id: number; name: string; role: string; avatar_url: string | null };
  initialUsers: User[];
  initialConversations: Conversation[];
};

/* ------------------------------- utilidades ------------------------------ */

/** Resposta da API do chat, tipada apenas no que o cliente usa. */
async function json<T>(res: Response): Promise<T> {
  return (await res.json().catch(() => ({}))) as T;
}
type ApiLista = {
  users?: User[];
  conversations?: Conversation[];
  unread?: number;
  unreadConversations?: number;
  unreadPorConversa?: { conversation_id: number; unread: number }[];
  error?: string;
};
type ApiMensagens = {
  messages?: Message[];
  other?: { id: number; name: string; username: string; avatar_url: string | null };
  unread?: number;
  unreadConversations?: number;
  unreadPorConversa?: { conversation_id: number; unread: number }[];
  error?: string;
};

/** Contadores: uma fonte so, a mesma do topo e do menu inferior. */
function semearContadores(d: { unread?: number; unreadConversations?: number; unreadPorConversa?: { conversation_id: number; unread: number }[] }) {
  seedUnread({
    unread: d.unread ?? 0,
    unreadConversations: d.unreadConversations ?? 0,
    conversations: d.unreadPorConversa ?? [],
  });
}

const MAX_BYTES = 1_500_000;

const iconeArquivo = (mime: string | null | undefined, nome: string | null | undefined) => {
  const m = (mime ?? "").toLowerCase();
  const n = (nome ?? "").toLowerCase();
  if (m.startsWith("image/")) return "🖼️";
  if (m.startsWith("audio/")) return "🎙️";
  if (m === "application/pdf" || n.endsWith(".pdf")) return "📕";
  if (m.includes("spreadsheet") || m.includes("excel") || /\.(xlsx?|csv)$/.test(n)) return "📊";
  if (m.includes("word") || m.includes("document") || /\.docx?$/.test(n)) return "📄";
  if (m.startsWith("text/") || /\.(txt|md)$/.test(n)) return "📃";
  return "📎";
};

const tamanho = (bytes: number | null | undefined) => {
  if (!bytes && bytes !== 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
};

const duracao = (s: number | null | undefined) => {
  const total = Math.max(0, Math.round(s ?? 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** "2026-09-08 14:32" / ISO -> texto amigavel no fuso do navegador. */
function quando(s: string | null | undefined) {
  if (!s) return "";
  const iso = s.includes("T") ? s : s.replace(" ", "T") + (s.length <= 16 ? ":00" : "");
  const d = new Date(iso + (/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return s;
  const hoje = new Date();
  const mesmoDia = d.toDateString() === hoje.toDateString();
  const ontem = new Date(hoje.getTime() - 864e5);
  const hora = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (mesmoDia) return hora;
  if (d.toDateString() === ontem.toDateString()) return `ontem ${hora}`;
  return `${d.toLocaleDateString("pt-BR")} ${hora}`;
}

function erroAmigavel(msg: string | undefined): string {
  if (!msg) return "Falha de conexão. Verifique a internet.";
  return msg;
}

/* ------------------------------- componente ------------------------------ */

export default function ChatApp({ me, initialUsers, initialConversations }: Props) {
  const [users, setUsers] = useState<User[]>(initialUsers);
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  // Contador de nao lidas: estado compartilhado (topo e menu leem o mesmo).
  const { unreadConversations: unreadConv } = useUnread();

  const [ativa, setAtiva] = useState<number | null>(null);
  const [mensagens, setMensagens] = useState<Message[]>([]);
  const [outra, setOutra] = useState<{ id: number; name: string; username: string; avatar_url: string | null } | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [temMais, setTemMais] = useState(false);
  const [busca, setBusca] = useState("");
  const [texto, setTexto] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState("");
  const [gravando, setGravando] = useState(false);
  const [tempoGravacao, setTempoGravacao] = useState(0);
  const [arrastando, setArrastando] = useState(false);
  const [tocando, setTocando] = useState<number | null>(null);
  const [online, setOnline] = useState(true);

  const fimRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const maiorIdRef = useRef(0);
  const anteriorRef = useRef(0);
  const gravadorRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const cancelarGravacaoRef = useRef(false);

  const ativaRef = useRef(ativa);
  ativaRef.current = ativa;
  const outraRef = useRef(outra);
  outraRef.current = outra;
  const tempoGravacaoRef = useRef(0);
  tempoGravacaoRef.current = tempoGravacao;
  const inicioRef = useRef(0);

  /* ------------------------------ carregamento ---------------------------- */

  const abrirConversa = useCallback(async (conversationId: number, mostrarMais = false) => {
    setAtiva(conversationId);
    setCarregando(true);
    setAviso("");
    try {
      const antes = mostrarMais ? anteriorRef.current : 0;
      const res = await fetch(`/api/chat?c=${conversationId}${antes ? `&before=${antes}` : ""}`, { cache: "no-store" });
      if (!res.ok) throw new Error();
      const data = await json<ApiMensagens>(res);
      if (data.error) throw new Error(data.error);
      const msgs: Message[] = (data.messages ?? []).map((m) => ({ ...m, mine: m.sender_id === me.id }));
      setMensagens((atuais) => (mostrarMais ? [...msgs, ...atuais] : msgs));
      setOutra(data.other ?? null);
      anteriorRef.current = msgs.length ? msgs[0].id : 0;
      if (!mostrarMais) {
        maiorIdRef.current = msgs.length ? msgs[msgs.length - 1].id : 0;
        setTemMais(msgs.length >= 40);
        void marcarLida(conversationId);
      } else {
        setTemMais(msgs.length >= 40);
      }
      requestAnimationFrame(() => fimRef.current?.scrollIntoView({ block: "end" }));
    } catch {
      setAviso("Não foi possível abrir a conversa.");
    } finally {
      setCarregando(false);
    }
  }, [me.id]);

  /**
   * Marca a conversa como lida e semeia o contador compartilhado com a
   * resposta: o badge do topo e do menu caem na hora, sem esperar polling.
   */
  const marcarLida = useCallback(async (conversationId: number) => {
    try {
      const res = await fetch("/api/chat", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "lida", c: conversationId }),
      });
      if (!res.ok) return;
      const data = await json<ApiLista>(res);
      semearContadores(data);
    } catch {
      /* offline: o proximo ciclo corrige */
    }
  }, []);

  /** Clique em um contato: abre a conversa existente ou prepara uma nova. */
  const conversarCom = useCallback((u: User) => {
    const existente = conversations.find((c) => c.other_id === u.id);
    if (existente) {
      void abrirConversa(existente.conversation_id);
    } else {
      setAtiva(-u.id); // conversa nova ainda sem mensagem
      setOutra({ id: u.id, name: u.name, username: u.username, avatar_url: u.avatar_url });
      setMensagens([]);
      setTemMais(false);
      maiorIdRef.current = 0;
      anteriorRef.current = 0;
    }
  }, [conversations, abrirConversa]);

  /* --------------------------- polling (tempo real) ----------------------- */

  useEffect(() => {
    let vivo = true;
    const listar = async () => {
      try {
        const res = await fetch("/api/chat", { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = await json<ApiLista>(res);
        if (!vivo) return;
        setOnline(true);
        setUsers(data.users ?? []);
        setConversations(data.conversations ?? []);
        // Fonte unica: topo e menu recebem os mesmos numeros daqui.
        semearContadores(data);
      } catch {
        if (vivo) setOnline(false);
      }
    };
    const pollMsgs = setInterval(async () => {
      const c = ativaRef.current;
      if (!c || c < 0) return;
      try {
        const res = await fetch(`/api/chat?c=${c}&after=${maiorIdRef.current}`, { cache: "no-store" });
        if (!res.ok) throw new Error();
        const data = await json<ApiMensagens>(res);
        if (data.error) throw new Error(data.error);
        if (!vivo) return;
        setOnline(true);
        const novas: Message[] = (data.messages ?? []).map((m: Message) => ({ ...m, mine: m.sender_id === me.id }));
        setMensagens((atuais) => {
          // descarta otimistas que ja chegaram do servidor (mesmo texto, meu id)
          const semOtimistas = atuais.filter(
            (m) => !(m.local && novas.some((n) => n.sender_id === me.id && (n.body ?? "") === (m.body ?? ""))),
          );
          const ids = new Set(semOtimistas.filter((m) => !m.local).map((m) => m.id));
          return [...semOtimistas, ...novas.filter((n) => !ids.has(n.id))];
        });
        if (novas.length) {
          maiorIdRef.current = Math.max(maiorIdRef.current, ...novas.map((n) => n.id));
          // rola so se o usuario ja estiver perto do fim (nao interrompe leitura antiga)
          const el = fimRef.current?.parentElement;
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
            requestAnimationFrame(() => fimRef.current?.scrollIntoView({ block: "end" }));
          }
          if (novas.some((n) => !n.mine)) {
            void marcarLida(c);
          }
        }
        semearContadores(data);
      } catch {
        if (vivo) setOnline(false);
      }
    }, 3000);
    void listar();
    const poll = setInterval(listar, 5000);
    return () => {
      vivo = false;
      clearInterval(poll);
      clearInterval(pollMsgs);
    };
  }, [me.id]);

  // A tela do chat tambem participa do ciclo compartilhado (idempotente):
  // o polling de contadores continua unico, mesmo com o sino montado.
  useEffect(() => {
    holdUnreadPolling();
    return () => releaseUnreadPolling();
  }, []);

  /* ------------------------------- envio ---------------------------------- */

  const despachar = useCallback(async (payload: { body?: string; files?: File[]; audio?: Blob | null; audioSeconds?: number | null; durationMs?: number | null }) => {
    const c = ativaRef.current;
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const otimista: Message = {
      id: -1,
      localId,
      conversation_id: c ?? 0,
      sender_id: me.id,
      body: payload.body ?? null,
      kind: payload.audio
        ? "audio"
        : payload.files?.length === 1 && payload.files[0].type.startsWith("image/")
          ? "image"
          : payload.files?.length
            ? "file"
            : "text",
      file_id: null,
      file_name: payload.files?.[0]?.name ?? null,
      file_mime: payload.files?.[0]?.type ?? null,
      file_size: payload.files?.[0]?.size ?? null,
      audio_seconds: payload.audioSeconds ?? null,
      duration_ms: null,
      read_at: null,
      deleted_at: null,
      created_at: "",
      mine: true,
      local: "sending",
      file: payload.files?.[0],
    };

    setMensagens((m) => [...m, otimista]);
    setEnviando(true);
    requestAnimationFrame(() => fimRef.current?.scrollIntoView({ block: "end" }));

    try {
      const fd = new FormData();
      if (c && c > 0) fd.set("c", String(c));
      if (outraRef.current && (!c || c < 0)) fd.set("para", String(outraRef.current.id));
      if (payload.body) fd.set("body", payload.body);
      if (payload.audio) {
        const tipo = payload.audio.type || "audio/webm";
        const ext = tipo.includes("mp4") ? "m4a" : tipo.includes("ogg") ? "ogg" : "webm";
        fd.set("audio", new File([payload.audio], `audio.${ext}`, { type: tipo }));
        if (payload.audioSeconds != null) fd.set("audio_seconds", String(Math.round(payload.audioSeconds)));
        if (payload.durationMs != null) fd.set("duration_ms", String(payload.durationMs));
      }
      payload.files?.forEach((f) => fd.append("files", f));

      const res = await fetch("/api/chat", { method: "POST", body: fd });
      const data = await json<{ ok?: boolean; messages?: Message[]; error?: string }>(res);
      if (!res.ok || data.error) throw new Error(data.error || "Falha ao enviar.");

      const criadas: Message[] = data.messages ?? [];
      // conversa nova: agora ela existe de verdade
      if (!c || c < 0) {
        const novaId = criadas[0]?.conversation_id;
        if (novaId) {
          ativaRef.current = novaId;
          setAtiva(novaId);
        }
      }
      setMensagens((m) => {
        const semOtimista = m.filter((x) => x.localId !== localId);
        const ids = new Set(semOtimista.filter((x) => !x.local).map((x) => x.id));
        return [...semOtimista, ...criadas.map((novo) => ({ ...novo, mine: true })).filter((novo) => !ids.has(novo.id))];
      });
      if (criadas.length) maiorIdRef.current = Math.max(maiorIdRef.current, ...criadas.map((x) => x.id));
      setOnline(true);
      requestAnimationFrame(() => fimRef.current?.scrollIntoView({ block: "end" }));
    } catch (e) {
      setMensagens((m) => m.map((x) => (x.localId === localId ? { ...x, local: "error" } : x)));
      setAviso(erroAmigavel(e instanceof Error ? e.message : undefined));
    } finally {
      setEnviando(false);
    }
  }, [me.id]);

  const reenviar = useCallback((msg: Message) => {
    setMensagens((m) => m.filter((x) => x.localId !== msg.localId));
    if (msg.body && msg.kind === "text") void despachar({ body: msg.body });
    else if (msg.file) void despachar({ files: [msg.file] });
  }, [despachar]);

  const enviarTexto = useCallback(() => {
    const t = texto.trim();
    if (!t || enviando) return;
    setTexto("");
    void despachar({ body: t });
  }, [texto, enviando, despachar]);

  const enviarArquivos = useCallback((lista: FileList | File[]) => {
    const files = Array.from(lista).filter(Boolean);
    if (!files.length) return;
    const grande = files.find((f) => f.size > MAX_BYTES);
    if (grande) {
      setAviso(`"${grande.name}" passa do limite de 1,5 MB por arquivo.`);
      return;
    }
    void despachar({ files });
  }, [despachar]);

  /* ------------------------------ gravacao -------------------------------- */

  const iniciarGravacao = useCallback(async () => {
    setAviso("");
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setAviso("Seu navegador não suporta gravação de áudio.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeHint = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find(
        (t) => MediaRecorder.isTypeSupported?.(t),
      );
      const rec = new MediaRecorder(stream, mimeHint ? { mimeType: mimeHint } : undefined);
      chunksRef.current = [];
      cancelarGravacaoRef.current = false;
      gravadorRef.current = rec;
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const segundos = tempoGravacaoRef.current;
        const ms = Date.now() - inicioRef.current;
        setGravando(false);
        setTempoGravacao(0);
        if (timerRef.current) clearInterval(timerRef.current);
        if (cancelarGravacaoRef.current) return; // cancelada: descarta sem enviar
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || "audio/webm" });
        if (!blob.size) {
          setAviso("A gravação ficou vazia. Tente novamente.");
          return;
        }
        if (blob.size > MAX_BYTES) {
          setAviso(`Áudio muito longo (${(blob.size / 1024 / 1024).toFixed(1)} MB). Grave algo mais curto.`);
          return;
        }
        await despachar({ audio: blob, audioSeconds: segundos, durationMs: ms });
      };
      rec.start(250);
      inicioRef.current = Date.now();
      setTempoGravacao(0);
      setGravando(true);
      timerRef.current = setInterval(() => setTempoGravacao((s) => s + 1), 1000);
    } catch {
      setAviso("Não foi possível acessar o microfone. Verifique a permissão do navegador.");
    }
  }, [despachar]);

  const pararGravacao = useCallback((cancelar = false) => {
    cancelarGravacaoRef.current = cancelar;
    try {
      gravadorRef.current?.stop();
    } catch {
      /* ja parado */
    }
  }, []);

  /* -------------------------------- audio --------------------------------- */

  const tocar = useCallback((m: Message) => {
    if (!m.file_id) return;
    const url = `/api/chat/arquivo/${m.file_id}?nome=${encodeURIComponent(m.file_name ?? "audio.webm")}`;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (tocando === m.id) {
      setTocando(null);
      return;
    }
    const el = new Audio(url);
    audioRef.current = el;
    el.onended = () => setTocando(null);
    el.onerror = () => {
      setTocando(null);
      setAviso("Não foi possível reproduzir o áudio.");
    };
    void el.play().then(() => setTocando(m.id)).catch(() => {
      setTocando(null);
      setAviso("Toque novamente para reproduzir o áudio.");
    });
  }, [tocando]);

  /* ------------------------------ listas ---------------------------------- */

  const conversasFiltradas = useMemo(() => {
    const q = busca.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) => c.other_name.toLowerCase().includes(q) || (c.last_body ?? "").toLowerCase().includes(q),
    );
  }, [conversations, busca]);

  const contatosFiltrados = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const comConversa = new Set(conversations.map((c) => c.other_id));
    const candidatos = q ? users : users.filter((u) => !comConversa.has(u.id));
    if (!q) return candidatos;
    return users.filter((u) => u.name.toLowerCase().includes(q) || u.username.toLowerCase().includes(q));
  }, [users, conversations, busca]);

  /* ------------------------------ exclusao -------------------------------- */

  const excluirMensagem = useCallback(async (m: Message) => {
    if (!window.confirm("Excluir esta mensagem para os dois?")) return;
    try {
      const res = await fetch(`/api/chat?id=${m.id}`, { method: "DELETE" });
      const data = await json<{ ok?: boolean; error?: string }>(res);
      if (!res.ok || data.error) throw new Error(data.error);
      setMensagens((atuais) =>
        atuais.map((x) => (x.id === m.id ? { ...x, body: null, file_id: null, deleted_at: "x" } : x)),
      );
    } catch (e) {
      setAviso(erroAmigavel(e instanceof Error ? e.message : undefined));
    }
  }, []);

  const arquivar = useCallback(async (c: Conversation) => {
    try {
      await fetch("/api/chat", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "arquivar", c: c.conversation_id, arquivar: true }),
      });
      setConversations((cs) => cs.filter((x) => x.conversation_id !== c.conversation_id));
      if (ativaRef.current === c.conversation_id) {
        setAtiva(null);
        setMensagens([]);
        setOutra(null);
      }
    } catch {
      setAviso("Não foi possível arquivar a conversa.");
    }
  }, []);

  /* ------------------------------- render --------------------------------- */

  return (
    <div className="chat-tela flex h-[calc(100dvh-11.5rem)] min-h-[26rem] gap-4 md:h-[calc(100dvh-8.5rem)]">
      {/* lista lateral */}
      <div className={`cartao flex w-full flex-col overflow-hidden md:w-80 md:shrink-0 ${ativa ? "hidden md:flex" : "flex"}`}>
        <div className="border-b border-nuvem-200 p-3">
          <div className="relative">
            <Icon name="busca" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar conversa ou pessoa…"
              className="campo pl-9"
            />
          </div>
          <p className="mt-2 text-xs text-stone-500">
            {online ? (unreadConv > 0 ? `${unreadConv} conversa(s) com mensagem nova` : "") : "Sem conexão — tentando reconectar…"}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {conversasFiltradas.length === 0 && !busca && (
            <p className="px-2 py-6 text-center text-sm text-stone-500">
              Nenhuma conversa ainda. Toque em um contato abaixo para começar.
            </p>
          )}
          {conversasFiltradas.map((c) => (
            <button
              key={c.conversation_id}
              onClick={() => void abrirConversa(c.conversation_id)}
              className={`flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition ${
                ativa === c.conversation_id ? "bg-marca-50" : "hover:bg-nuvem-100"
              }`}
            >
              <Avatar src={c.other_avatar_url} name={c.other_name} className="h-10 w-10 text-sm" bg="bg-marca-600 text-white" />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-bold text-tinta-900">{c.other_name}</span>
                  <span className="shrink-0 text-[0.68rem] text-stone-400">{quando(c.last_created_at)}</span>
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className={`truncate text-xs ${c.unread ? "font-semibold text-tinta-800" : "text-stone-500"}`}>
                    {c.last_sender_id === me.id ? "Você: " : ""}
                    {c.last_kind === "audio" ? "🎙️ Áudio"
                      : c.last_kind === "image" ? "🖼️ Imagem"
                      : c.last_kind === "file" ? `📎 ${c.last_body ?? ""}`
                      : c.last_body || "…"}
                  </span>
                  {c.unread > 0 && (
                    <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-marca-600 px-1.5 text-[0.65rem] font-bold text-white">
                      {c.unread > 99 ? "99+" : c.unread}
                    </span>
                  )}
                </span>
              </span>
            </button>
          ))}

          {contatosFiltrados.length > 0 && (
            <p className="mt-3 px-2 pb-1 text-[0.68rem] font-bold uppercase tracking-wide text-stone-400">
              Iniciar nova conversa
            </p>
          )}
          {contatosFiltrados.map((u) => (
            <button
              key={u.id}
              onClick={() => conversarCom(u)}
              className="flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition hover:bg-nuvem-100"
            >
              <Avatar src={u.avatar_url} name={u.name} className="h-10 w-10 text-sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-tinta-900">{u.name}</span>
                <span className="block truncate text-xs capitalize text-stone-500">{u.role}</span>
              </span>
              <Icon name="mais" className="h-4 w-4 shrink-0 text-stone-400" />
            </button>
          ))}
        </div>
      </div>

      {/* conversa */}
      <div className={`cartao min-w-0 flex-1 flex-col overflow-hidden ${ativa ? "flex" : "hidden md:flex"}`}>
        {!ativa || !outra ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
            <span className="text-3xl">💬</span>
            <p className="text-sm text-stone-500">Escolha uma conversa ou inicie uma nova ao lado.</p>
          </div>
        ) : (
          <>
            {/* cabecalho */}
            <div className="flex items-center gap-3 border-b border-nuvem-200 px-3 py-2.5">
              <button
                className="rounded-xl p-1.5 text-tinta-700 hover:bg-nuvem-100 md:hidden"
                onClick={() => {
                  setAtiva(null);
                  setMensagens([]);
                }}
                aria-label="Voltar para a lista"
              >
                <Icon name="saida" className="h-5 w-5" />
              </button>
              <Avatar src={outra.avatar_url} name={outra.name} className="h-9 w-9 text-xs" bg="bg-marca-600 text-white" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold text-tinta-900">{outra.name}</p>
                <p className="truncate text-xs text-stone-500">@{outra.username}</p>
              </div>
              {ativa > 0 && (
                <button
                  onClick={() => {
                    const conv = conversations.find((x) => x.conversation_id === ativa);
                    if (conv) void arquivar(conv);
                  }}
                  className="rounded-xl p-2 text-stone-400 hover:bg-nuvem-100 hover:text-stone-600"
                  title="Arquivar conversa"
                  aria-label="Arquivar conversa"
                >
                  📥
                </button>
              )}
            </div>

            {/* mensagens */}
            <div
              className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 py-3"
              onDragOver={(e) => {
                e.preventDefault();
                setArrastando(true);
              }}
              onDragLeave={() => setArrastando(false)}
              onDrop={(e) => {
                e.preventDefault();
                setArrastando(false);
                if (e.dataTransfer?.files?.length) enviarArquivos(e.dataTransfer.files);
              }}
            >
              {temMais && ativa > 0 && (
                <div className="flex justify-center pb-2">
                  <button
                    onClick={() => void abrirConversa(ativa, true)}
                    className="rounded-full border border-nuvem-300 bg-white px-3 py-1.5 text-xs font-semibold text-marca-600"
                  >
                    Carregar mensagens anteriores
                  </button>
                </div>
              )}
              {carregando && mensagens.length === 0 && (
                <p className="py-8 text-center text-sm text-stone-400">Carregando conversa…</p>
              )}
              {mensagens.map((m, i) => {
                const anterior = mensagens[i - 1];
                const quebraDia = !anterior || anterior.created_at?.slice(0, 10) !== m.created_at?.slice(0, 10);
                return (
                  <div key={m.localId ?? m.id}>
                    {quebraDia && m.created_at && (
                      <p className="py-2 text-center text-[0.68rem] font-semibold uppercase tracking-wide text-stone-400">
                        {quando(m.created_at)}
                      </p>
                    )}
                    <div className={`group flex ${m.mine ? "justify-end" : "justify-start"}`}>
                      {/* Foto do remetente nas mensagens recebidas; as proprias
                          ficam a direita, sem avatar, como no mensageiro. */}
                      {!m.mine && !m.deleted_at && (
                        <Avatar
                          src={m.sender_avatar_url}
                          name={outra?.name ?? ""}
                          className="mr-1.5 mt-auto h-7 w-7 text-[0.6rem]"
                        />
                      )}
                      {m.deleted_at ? (
                        <div className="max-w-[80%] rounded-2xl bg-nuvem-100 px-3 py-2 text-xs italic text-stone-400">
                          mensagem excluída
                        </div>
                      ) : m.local === "error" ? (
                        <div className="max-w-[80%] rounded-2xl border border-red-300 bg-red-50 px-3 py-2">
                          <p className="text-sm text-red-800">{m.body ?? `Falha ao enviar ${m.file_name ?? "arquivo"}`}</p>
                          <button onClick={() => reenviar(m)} className="mt-1 text-xs font-semibold text-red-700 underline">
                            Tentar novamente
                          </button>
                        </div>
                      ) : (
                        <div
                          className={`max-w-[85%] rounded-2xl px-3 py-2 sm:max-w-[70%] ${
                            m.mine ? "bg-marca-600 text-white" : "bg-nuvem-100 text-tinta-900"
                          } ${m.local === "sending" ? "opacity-60" : ""}`}
                        >
                          {m.kind === "audio" && (m.file_id || m.local === "sending") ? (
                            <button
                              onClick={() => m.file_id && tocar(m)}
                              className="flex items-center gap-2 py-0.5"
                              disabled={!m.file_id}
                            >
                              <span className={`flex h-8 w-8 items-center justify-center rounded-full ${m.mine ? "bg-white/20" : "bg-marca-600/10"}`}>
                                {tocando === m.id ? "⏸" : "▶"}
                              </span>
                              <span className="flex items-end gap-[2px]" aria-hidden>
                                {[6, 12, 8, 14, 9, 13, 7, 11].map((h, j) => (
                                  <span key={j} className={`w-[3px] rounded-full ${m.mine ? "bg-white/70" : "bg-marca-600/50"}`} style={{ height: h }} />
                                ))}
                              </span>
                              <span className="text-xs font-semibold">{duracao(m.audio_seconds)}</span>
                            </button>
                          ) : m.kind === "image" && (m.file_id || m.local === "sending") ? (
                            <a
                              href={m.file_id ? `/api/chat/arquivo/${m.file_id}?nome=${encodeURIComponent(m.file_name ?? "")}` : undefined}
                              target="_blank"
                              rel="noreferrer"
                              className="block overflow-hidden rounded-xl"
                            >
                              {m.local === "sending" && m.file ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={URL.createObjectURL(m.file)} alt={m.file_name ?? ""} className="max-h-56 w-auto" />
                              ) : (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img src={`/api/chat/arquivo/${m.file_id}?nome=${encodeURIComponent(m.file_name ?? "")}`} alt={m.file_name ?? ""} className="max-h-56 w-auto" loading="lazy" />
                              )}
                            </a>
                          ) : m.kind === "file" && (m.file_id || m.local === "sending") ? (
                            <a
                              href={m.file_id ? `/api/chat/arquivo/${m.file_id}?nome=${encodeURIComponent(m.file_name ?? "")}&download=1` : undefined}
                              className={`flex items-center gap-2 ${m.mine ? "text-white" : "text-tinta-900"}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              <span className="text-xl">{iconeArquivo(m.file_mime, m.file_name)}</span>
                              <span className="min-w-0">
                                <span className="block max-w-44 truncate text-sm font-semibold underline">{m.file_name}</span>
                                <span className="block text-xs opacity-70">{tamanho(m.file_size)}</span>
                              </span>
                            </a>
                          ) : (
                            <p className="whitespace-pre-wrap break-words text-sm">{m.body}</p>
                          )}
                          <div className={`mt-0.5 flex items-center justify-end gap-1 text-[0.62rem] ${m.mine ? "text-white/70" : "text-stone-400"}`}>
                            {m.created_at && <span>{quando(m.created_at).slice(-5)}</span>}
                            {m.mine && !m.local && <span title={m.read_at ? "Lida" : "Enviada"}>{m.read_at ? "✓✓" : "✓"}</span>}
                            {m.local === "sending" && <span>enviando…</span>}
                            {m.mine && m.file_id && !m.local && (
                              <button
                                onClick={() => void excluirMensagem(m)}
                                className="ml-1 opacity-0 transition group-hover:opacity-100 focus:opacity-100"
                                title="Excluir mensagem"
                              >
                                🗑
                              </button>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
              {arrastando && (
                <div className="rounded-xl border-2 border-dashed border-marca-400 bg-marca-50 p-4 text-center text-sm font-semibold text-marca-600">
                  Solte o arquivo para enviar
                </div>
              )}
              <div ref={fimRef} />
            </div>

            {/* aviso de erro */}
            {aviso && (
              <div className="mx-3 mb-1 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {aviso}                  <button onClick={() => setAviso("")} className="ml-2 font-bold underline">Fechar</button>
              </div>
            )}

            {/* composer */}
            <div className="flex items-end gap-2 border-t border-nuvem-200 p-2.5">
              {gravando ? (
                <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-red-50 px-3 py-2.5">
                  <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-600" />
                  <span className="text-sm font-semibold text-red-700">{duracao(tempoGravacao)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-red-600">gravando áudio…</span>
                  <button
                    onClick={() => pararGravacao(true)}
                    className="rounded-xl px-2 py-1.5 text-sm font-semibold text-red-700 hover:bg-red-100"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={() => pararGravacao(false)}
                    className="rounded-xl bg-marca-600 px-3 py-1.5 text-sm font-semibold text-white"
                  >
                    Enviar
                  </button>
                </div>
              ) : (
                <>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    accept="image/*,application/pdf,audio/*,.doc,.docx,.xls,.xlsx,.csv,.txt,.md,.json"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files?.length) enviarArquivos(e.target.files);
                      e.target.value = "";
                    }}
                  />
                  <button
                    onClick={() => fileRef.current?.click()}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-stone-500 hover:bg-nuvem-100"
                    title="Anexar arquivo"
                    aria-label="Anexar arquivo"
                  >
                    📎
                  </button>
                  <textarea
                    value={texto}
                    onChange={(e) => setTexto(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        enviarTexto();
                      }
                    }}
                    rows={1}
                    placeholder="Mensagem…"
                    className="campo max-h-32 min-h-11 flex-1 resize-none py-2.5"
                  />
                  {texto.trim() ? (
                    <button
                      onClick={enviarTexto}
                      disabled={enviando}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-marca-600 text-white transition active:scale-95 disabled:opacity-50"
                      title="Enviar mensagem"
                      aria-label="Enviar mensagem"
                    >
                      {enviando ? "…" : <Icon name="seta" className="h-5 w-5" />}
                    </button>
                  ) : (
                    <button
                      onClick={() => void iniciarGravacao()}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-marca-600 text-white transition active:scale-95"
                      title="Gravar áudio"
                      aria-label="Gravar áudio"
                    >
                      🎙️
                    </button>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
