"use client";
import { useEffect } from "react";
import { useSyncExternalStore } from "react";
import { assinarProgresso, progressoPendentes, registrarProgresso } from "@/lib/progresso-acoes";

/**
 * Sinalizacao global de espera do servidor — GENERALIZADA (auditoria de
 * percepcao de lentidao).
 *
 * PROBLEMA: a versao anterior so cobria forms com <SubmitButton>. A auditoria
 * de TODOS os gatilhos do sistema encontrou 146 forms — 125 com SubmitButton,
 * 10 com action de servidor e botao cru, 3 GET/URL, 8 sem action — alem de
 * botoes client que chamam server action fora de form (faturamento,
 * configuracoes). Caçar botao por botao nao era generalizavel.
 *
 * EVIDENCIA que definiu o desenho (medido no navegador da aplicacao): toda
 * server action vai por `window.fetch` com o header `next-action`, e toda
 * navegacao do App Router vai por fetch com `rsc` — o prefetch de link vem com
 * `next-router-prefetch` a mais. Entao um unico interceptor no layout RAIZ
 * cobre:
 *
 *   - os 146 forms (SubmitButton, botao cru ou botao implicito);
 *   - server actions disparadas por onClick fora de form;
 *   - navegacoes entre telas (mesmo as que terminam antes de montar o shell);
 *
 *   ...e IGNORA o prefetch (hover/viewport), senao a barra piscaria so de a
 * tela existir. Requests de API comuns (/api/*, polling de chat, uploads) nao
 * carregam `next-action` nem `rsc`, entao ficam de fora — barra so onde ha
 * espera de servidor percebida.
 *
 * Instalado UMA vez por sessao (guarda de modulo) dentro de useEffect — o
 * React/Next resolve `fetch` no momento da chamada, entao o patch pega tudo a
 * partir da hidratacao (confirmado em teste real: a action apareceu no
 * interceptor). Modulo sem chamada de React no escopo (padrao chat-unread):
 * importar de qualquer pagina e inofensivo sob `--conditions=react-server`.
 */
let instalado = false;

function chavesDeCabecalho(input: RequestInfo | URL, init?: RequestInit): Set<string> {
  const brutas: HeadersInit | undefined = init?.headers ?? (typeof input === "object" && "headers" in input ? (input as Request).headers : undefined);
  const chaves = new Set<string>();
  if (!brutas) return chaves;
  if (typeof Headers !== "undefined" && brutas instanceof Headers) {
    brutas.forEach((_v, k) => chaves.add(k.toLowerCase()));
  } else if (Array.isArray(brutas)) {
    for (const [k] of brutas) chaves.add(String(k).toLowerCase());
  } else {
    for (const k of Object.keys(brutas)) chaves.add(k.toLowerCase());
  }
  return chaves;
}

/** Espera de servidor que o usuario percebe: action ou navegacao (nao prefetch). */
function ehEsperaPercibivel(input: RequestInfo | URL, init?: RequestInit): boolean {
  const h = chavesDeCabecalho(input, init);
  if (h.has("next-action")) return true;
  return h.has("rsc") && !h.has("next-router-prefetch");
}

function instalarInterceptor() {
  if (instalado || typeof window === "undefined") return;
  instalado = true;
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    let conta = false;
    try {
      conta = ehEsperaPercibivel(input, init);
    } catch {
      conta = false; // jamais quebrar a requisicao por causa da instrumentacao
    }
    if (!conta) return original(input, init);
    registrarProgresso(true);
    // finally cobre erro de rede e abort: o contador nunca fica preso.
    return original(input, init).finally(() => registrarProgresso(false));
  };
}

export function ProgressoAcoes() {
  useEffect(() => {
    instalarInterceptor();
  }, []);
  return <BarraProgresso />;
}

function BarraProgresso() {
  const pendentes = useSyncExternalStore(assinarProgresso, progressoPendentes, progressoPendentes);
  if (pendentes === 0) return null;
  return (
    <div
      className="fixed inset-x-0 top-0 z-50 h-1 overflow-hidden bg-nuvem-200"
      role="status"
      aria-label="Salvando alterações…"
      data-progresso-acoes=""
    >
      <div
        className="h-full w-1/3 rounded-full bg-marca-600"
        style={{ animation: "progresso-acoes 1.1s ease-in-out infinite" }}
      />
      <style>{`@keyframes progresso-acoes { 0% { transform: translateX(-100%) } 100% { transform: translateX(300%) } }`}</style>
    </div>
  );
}
