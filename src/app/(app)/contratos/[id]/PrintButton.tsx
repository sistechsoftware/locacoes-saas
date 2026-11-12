"use client";

import { useEffect, useState } from "react";
import { BTN } from "@/components/ui";

/**
 * Botao de impressao de todos os documentos do sistema (contrato, contrato
 * assinado, orcamento, reserva, recibo e portal do cliente — todos importam
 * este componente).
 *
 * No iOS 27 o `window.print()` deixou de abrir a folha de impressao quando o
 * app roda INSTALADO na tela de inicio (display-mode: standalone): a chamada
 * executa, nenhum erro aparece e o evento `beforeprint` nunca dispara. No
 * Safari comum o mesmo botao continua funcionando, entao o clique precisa de
 * dois caminhos:
 *
 *   1. navegador (ou qualquer ambiente onde imprimir funciona): chama
 *      `window.print()` como sempre fez;
 *   2. PWA no iOS: tenta imprimir e, se `beforeprint` nao disparar em 1,2 s,
 *      reabre o MESMO documento no Safari (`x-safari-<url>`), onde a impressao
 *      funciona. A URL leva `?imprimir=1` e, ao montar do outro lado, este
 *      componente limpa o parametro e abre a folha de impressao sozinho.
 *
 * O teste e por comportamento (`beforeprint`) e nao por versao do iOS: quando
 * a Apple corrigir a regressao, a impressao abre direto no PWA e nenhum
 * redirecionamento acontece.
 */
const PARAM_IMPRESSAO = "imprimir";
const ESPERA_BEFOREPRINT_MS = 1200;

/** App aberto pela tela de inicio (e nao numa aba do navegador). */
function estaInstalado(): boolean {
  const nav = window.navigator as Navigator & { standalone?: boolean };
  return window.matchMedia("(display-mode: standalone)").matches || nav.standalone === true;
}

function ehIOS(): boolean {
  const ua = window.navigator.userAgent;
  // iPadOS 13+ se apresenta como Mac com touch: o "ontouchend" separa do Mac real
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && "ontouchend" in document);
}

export default function PrintButton() {
  const [aviso, setAviso] = useState<string | null>(null);
  const [destino, setDestino] = useState<string | null>(null);

  /* De volta do Safari com ?imprimir=1: tira o parametro (para o botao e o
     recarregar nao repetirem) e abre a impressao — aqui ela funciona. */
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(PARAM_IMPRESSAO)) return;
    url.searchParams.delete(PARAM_IMPRESSAO);
    window.history.replaceState(null, "", url.toString());
    // dentro do proprio PWA imprimir nao abre nada: nao insiste
    if (estaInstalado()) return;
    const t = window.setTimeout(() => window.print(), 350);
    return () => window.clearTimeout(t);
  }, []);

  function abrirNoSafari() {
    const url = new URL(window.location.href);
    url.searchParams.set(PARAM_IMPRESSAO, "1");
    const alvo = `x-safari-${url.toString()}`;
    setDestino(alvo);
    setAviso(
      "O app instalado não abre a impressão neste iOS. Abrindo o documento no Safari — se nada acontecer, toque em",
    );
    window.location.href = alvo;
  }

  function imprimir() {
    setAviso(null);
    if (!estaInstalado() || !ehIOS()) {
      window.print();
      return;
    }

    /* iOS instalado: so o `beforeprint` diz se a folha de impressao abriu. */
    let abriu = false;
    const aoImprimir = () => {
      abriu = true;
    };
    window.addEventListener("beforeprint", aoImprimir);
    window.print();
    window.setTimeout(() => {
      window.removeEventListener("beforeprint", aoImprimir);
      if (!abriu) abrirNoSafari();
    }, ESPERA_BEFOREPRINT_MS);
  }

  return (
    <div className="nao-imprimir flex flex-col items-start gap-1">
      <button type="button" onClick={imprimir} className={BTN.primario}>
        Imprimir / PDF
      </button>
      {aviso && (
        <p className="max-w-[17rem] text-xs leading-snug text-stone-600">
          {aviso}{" "}
          {destino && (
            <a href={destino} className="font-semibold text-marca-600 underline">
              Abrir no Safari
            </a>
          )}
        </p>
      )}
    </div>
  );
}
