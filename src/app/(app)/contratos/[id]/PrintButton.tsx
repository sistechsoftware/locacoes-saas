"use client";

import { useEffect, useRef, useState } from "react";
import { BTN } from "@/components/ui";
import {
  aoSairDoApp,
  ehIOS,
  estaInstalado,
  linkSafari,
  PARAM_IMPRESSAO,
  urlComImpressao,
  urlDoDocumento,
} from "@/lib/impressao";

/**
 * Botao de impressao de todos os documentos do sistema (contrato, contrato
 * assinado, orcamento, reserva, recibo e portal do cliente — todos importam
 * este componente).
 *
 * No iOS 27 o `window.print()` deixou de abrir a folha de impressao quando o
 * app roda INSTALADO na tela de inicio (display-mode: standalone): a chamada
 * executa, nenhum erro aparece e o evento `beforeprint` nunca dispara. No
 * Safari comum o mesmo botao continua funcionando, entao o clique tem dois
 * caminhos:
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
 *
 * O `x-safari-` nao e documentado e pode ser ignorado sem aviso. Por isso o
 * caminho nunca termina em beco sem saida: se o app continuar em primeiro
 * plano 1,5 s depois da tentativa, aparece um painel com o ENDERECO do
 * documento (selecionavel e copiavel) e um link para tentar o Safari de novo —
 * o usuario imprime colando o endereco no Safari. O mesmo fluxo e testavel em
 * /diagnostico-pwa.
 */
const ESPERA_BEFOREPRINT_MS = 1200;
const ESPERA_SAIR_DO_APP_MS = 1500;
const ESPERA_IMPRESSAO_NO_SAFARI_MS = 350;

export default function PrintButton() {
  /** "pronto" = botao normal; "saindo" = tentando o Safari; "manual" = sem saida automatica */
  const [estado, setEstado] = useState<"pronto" | "saindo" | "manual">("pronto");
  const [manual, setManual] = useState<{ url: string; alvo: string } | null>(null);
  const [copiado, setCopiado] = useState<"nao" | "ok" | "manual">("nao");
  const campo = useRef<HTMLInputElement | null>(null);
  const vivo = useRef(true);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  /* Voltando do Safari com ?imprimir=1: limpa a flag (para o botao e o
     recarregar nao repetirem) e abre a impressao — aqui ela funciona. */
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(PARAM_IMPRESSAO)) return;
    url.searchParams.delete(PARAM_IMPRESSAO);
    window.history.replaceState(null, "", url.toString());
    // dentro do proprio PWA imprimir nao abre nada: nao insiste
    if (estaInstalado()) return;
    const t = window.setTimeout(() => window.print(), ESPERA_IMPRESSAO_NO_SAFARI_MS);
    return () => window.clearTimeout(t);
  }, []);

  /* De volta ao app depois de tentar o Safari: o botao volta ao normal. O
     painel manual, quando apareceu, continua na tela (e a saida do usuario). */
  useEffect(() => {
    const aoVoltar = () => {
      if (document.visibilityState === "visible") setEstado((e) => (e === "saindo" ? "pronto" : e));
    };
    document.addEventListener("visibilitychange", aoVoltar);
    return () => document.removeEventListener("visibilitychange", aoVoltar);
  }, []);

  /**
   * Endereço que vai para o Safari. Passa por `/login?proximo=<documento>`
   * porque o Safari do iPhone tem sessão SEPARADA do app instalado (cookie
   * jars isolados por design): na primeira impressão ele pede login e, com o
   * `proximo`, devolve o usuário no documento já com a impressão armada; nas
   * seguintes o /login reconhece a sessão e cai direto nele.
   */
  function enderecoSafari(): { copiavel: string; alvo: string } {
    const documento = urlComImpressao();
    const porta = new URL("/login", documento.origin);
    porta.searchParams.set("proximo", `${documento.pathname}${documento.search}`);
    return { copiavel: porta.toString(), alvo: linkSafari(porta) };
  }

  /** Abre o documento no Safari e vigia se o app realmente saiu da frente. */
  function irParaSafari() {
    const { copiavel, alvo } = enderecoSafari();
    setManual({ url: copiavel, alvo });
    setCopiado("nao");
    setEstado("saindo");

    let saiu = false;
    const parar = aoSairDoApp(() => {
      saiu = true;
    });
    window.location.href = alvo;

    window.setTimeout(() => {
      parar();
      if (!vivo.current || saiu) return;
      // o esquema foi ignorado: o app continua aberto => oferece o caminho manual
      setEstado("manual");
    }, ESPERA_SAIR_DO_APP_MS);
  }

  function imprimir() {
    setEstado("pronto");
    setManual(null);
    setCopiado("nao");
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
      if (!abriu) irParaSafari();
    }, ESPERA_BEFOREPRINT_MS);
  }

  async function copiarEndereco() {
    const texto = manual?.url ?? urlDoDocumento().toString();
    try {
      await navigator.clipboard.writeText(texto);
      setCopiado("ok");
    } catch {
      // sem permissao de area de transferencia: seleciona o campo para o
      // usuario copiar pelo menu do proprio iOS (toque longo > Copiar)
      campo.current?.focus();
      campo.current?.select();
      setCopiado("manual");
    }
  }

  return (
    <div className="nao-imprimir flex w-full max-w-[22rem] flex-col items-start gap-1">
      <button type="button" onClick={imprimir} className={BTN.primario}>
        {estado === "saindo" ? "Abrindo no Safari…" : "Imprimir / PDF"}
      </button>

      {estado === "manual" && manual && (
        <div
          role="status"
          className="w-full space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs leading-snug text-amber-900"
        >
          <p className="text-sm font-bold">A impressão não abriu neste app.</p>
          <p>
            O app instalado não abre a folha de impressão e o atalho para o Safari não respondeu. O documento não se
            perde: o endereço está abaixo.
          </p>
          <p>
            Ele abre o documento <b>pelo Safari</b>, que no iPhone tem sessão separada do app instalado — se pedir
            login, é só na primeira vez, e você volta direto para o documento.
          </p>
          <input
            ref={campo}
            readOnly
            value={manual.url}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Endereço do documento"
            className="campo text-[0.7rem]"
          />
          <div className="flex flex-wrap gap-2">
            <a href={manual.alvo} className={`${BTN.secundario} px-3 py-2 text-xs`}>
              Tentar no Safari
            </a>
            <button type="button" onClick={copiarEndereco} className={`${BTN.secundario} px-3 py-2 text-xs`}>
              {copiado === "ok" ? "Copiado" : "Copiar endereço"}
            </button>
          </div>
          {copiado === "ok" && (
            <p>
              Endereço copiado. Abra o <b>Safari</b>, cole na barra de endereço e toque em <b>Imprimir / PDF</b> na
              própria página. Se o Safari pedir login, entre: ele devolve você no documento.
            </p>
          )}
          {copiado === "manual" && (
            <p>
              O endereço está selecionado acima: toque e segure para <b>Copiar</b>, abra o <b>Safari</b> e cole na
              barra de endereço.
            </p>
          )}
          {copiado === "nao" && (
            <p className="text-amber-800/80">
              No Safari a impressão funciona: cole o endereço acima lá e toque em <b>Imprimir / PDF</b>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
