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
   * Endereço que vai para o Safari JÁ AUTENTICADO.
   *
   * O app instalado e o Safari têm cookie jars separados no iOS, então pedir
   * login de novo não faz sentido: quem pediu a impressão já está logado aqui.
   * O app pede ao servidor uma sessão CURTA do próprio usuário e a leva na
   * URL — `/sessao-impressao?s=…&proximo=…` adota o cookie no Safari e cai no
   * documento, que abre a impressão sozinho (`?imprimir=1`).
   *
   * Se o servidor recusar (sessão expirada, rede, conta bloqueada), o caminho
   * com login continua valendo como reserva: nunca fica sem saída.
   */
  async function enderecoSafari(): Promise<{ url: string; alvo: string }> {
    const documento = urlComImpressao();
    const caminhoDoc = `${documento.pathname}${documento.search}`;
    try {
      const resposta = await fetch("/api/impressao/sessao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proximo: caminhoDoc }),
      });
      const dados = (await resposta.json()) as { caminho?: string; error?: string };
      if (resposta.ok && dados.caminho) {
        const porta = new URL(dados.caminho, documento.origin);
        return { url: porta.toString(), alvo: linkSafari(porta) };
      }
    } catch {
      /* rede fora ou cookie indisponível: segue para o caminho com login */
    }
    const porta = new URL("/login", documento.origin);
    porta.searchParams.set("proximo", caminhoDoc);
    return { url: porta.toString(), alvo: linkSafari(porta) };
  }

  /** Abre o documento no Safari e vigia se o app realmente saiu da frente. */
  async function irParaSafari() {
    setEstado("saindo");
    setCopiado("nao");
    const { url, alvo } = await enderecoSafari();
    if (!vivo.current) return;
    setManual({ url, alvo });

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
            Ele abre o documento <b>no Safari já na sua conta</b> (a sessão vai junto, sem senha) e a impressão sai de
            lá. O endereço abaixo vale por 10 minutos.
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
              Endereço copiado. Abra o <b>Safari</b> e cole na barra de endereço: ele abre o documento já na sua conta e
              a folha de impressão aparece (vale por 10 minutos).
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
