"use client";

import { useEffect, useState } from "react";
import { aoSairDoApp, ehIOS, estaInstalado, linkSafari, urlComImpressao, urlDoDocumento } from "@/lib/impressao";

/*
 * Diagnostico de splash screen (apple-touch-startup-image) no iPhone.
 *
 * Pagina publica e inofensiva: nao toca no banco nem em dados — so le o que o
 * proprio navegador reporta. Serve para responder, no aparelho real:
 *   1. qual resolucao/DPR o iOS esta reportando;
 *   2. qual (se alguma) das media queries das splash bate;
 *   3. se os <link> de startup image estao no <head> desta pagina;
 *   4. se a imagem correspondente baixa com sucesso.
 */

const IPHONES = [
  { w: 320, h: 568, dpr: 2 },
  { w: 375, h: 667, dpr: 2 },
  { w: 375, h: 812, dpr: 3 },
  { w: 390, h: 844, dpr: 3 },
  { w: 393, h: 852, dpr: 3 },
  { w: 414, h: 736, dpr: 3 },
  { w: 414, h: 896, dpr: 2 }, // iPhone 11 / XR
  { w: 414, h: 896, dpr: 3 },
  { w: 428, h: 926, dpr: 3 },
  { w: 430, h: 932, dpr: 3 },
  { w: 440, h: 956, dpr: 3 },
] as const;

type Resultado = {
  tela: string;
  dpr: number;
  standalone: boolean;
  ua: string;
  comOrientacao: string[];
  semOrientacao: string[];
  totalLinks: number;
  imgTeste: "ok" | "falhou" | "testando" | "n/a";
};

export default function DiagnosticoPwaPage() {
  const [r, setR] = useState<Resultado | null>(null);

  useEffect(() => {
    const q = (s: string) => window.matchMedia(s).matches;

    const comOrientacao: string[] = [];
    const semOrientacao: string[] = [];
    let urlTeste: string | null = null;

    for (const { w, h, dpr } of IPHONES) {
      const retrato = `(orientation: portrait) and (device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr})`;
      const paisagem = `(orientation: landscape) and (device-width: ${h}px) and (device-height: ${w}px) and (-webkit-device-pixel-ratio: ${dpr})`;
      const sem = `(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr})`;
      if (q(retrato)) {
        comOrientacao.push(`${w}x${h} @${dpr}x retrato -> /splash/apple-splash-${w * dpr}-${h * dpr}.png`);
        urlTeste = urlTeste ?? `/splash/apple-splash-${w * dpr}-${h * dpr}.png`;
      }
      if (q(paisagem)) comOrientacao.push(`${h}x${w} @${dpr}x paisagem -> /splash/apple-splash-${h * dpr}-${w * dpr}.png`);
      if (q(sem)) semOrientacao.push(`${w}x${h} @${dpr}x`);
    }

    const links = Array.from(document.head.querySelectorAll('link[rel="apple-touch-startup-image"]'));
    const base: Resultado = {
      tela: `${screen.width}x${screen.height}`,
      dpr: window.devicePixelRatio,
      standalone: (navigator as unknown as { standalone?: boolean }).standalone === true,
      ua: navigator.userAgent,
      comOrientacao,
      semOrientacao,
      totalLinks: links.length,
      imgTeste: urlTeste ? "testando" : "n/a",
    };
    setR(base);

    if (urlTeste) {
      const img = new Image();
      img.onload = () => setR((p) => (p ? { ...p, imgTeste: "ok" } : p));
      img.onerror = () => setR((p) => (p ? { ...p, imgTeste: "falhou" } : p));
      img.src = urlTeste;
    }
  }, []);

    return (
    <main className="mx-auto max-w-md space-y-4 p-4">
      <h1 className="text-xl font-bold text-tinta-900">Diagnóstico de splash (PWA)</h1>
      <p className="text-sm text-stone-500">
        Esta página só lê o que o próprio navegador reporta. Abra no Safari do iPhone.
      </p>

      {!r ? (
        <p className="text-sm text-stone-500">Medindo…</p>
      ) : (
        <>
          <div className="cartao p-4">
            <Linha k="Tela (CSS px)" v={r.tela} />
            <Linha k="DPR reportado" v={`${r.dpr}x`} />
            <Linha k="Aberto como PWA?" v={r.standalone ? "sim (standalone)" : "não (Safari)"} />
            <Linha k="Links de splash no <head>" v={r.totalLinks} />
            <Linha k="Imagem do tamanho batido carrega?" v={r.imgTeste} />
          </div>

          <div className="cartao p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-stone-500">
              Media queries que bateram (com orientação — as usadas pelo app)
            </h2>
            {r.comOrientacao.length === 0 ? (
              <p className="rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-800">
                NENHUMA bateu — este é o problema: o iOS não encontrou imagem para este aparelho.
              </p>
            ) : (
              <ul className="space-y-1 text-sm text-tinta-900">
                {r.comOrientacao.map((m) => (
                  <li key={m}>✅ {m}</li>
                ))}
              </ul>
            )}
          </div>

          <div className="cartao p-4">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-stone-500">
              Bateriam sem exigir orientação (referência)
            </h2>
            {r.semOrientacao.length === 0 ? (
              <p className="text-sm text-stone-500">Nenhuma.</p>
            ) : (
              <ul className="space-y-1 text-sm text-tinta-900">
                {r.semOrientacao.map((m) => (
                  <li key={m}>• {m}</li>
                ))}
              </ul>
            )}
          </div>

          <ImpressaoPwa />

          <div className="cartao p-4 text-xs text-stone-500 break-all">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-stone-500">User agent</h2>
            {r.ua}
          </div>
        </>
      )}
    </main>
  );
}

/**
 * Impressao no PWA — testa EXATAMENTE o caminho que o botao "Imprimir / PDF"
 * dos documentos usa (src/lib/impressao.ts + PrintButton), para o usuario
 * validar no aparelho real o que nao da para simular daqui:
 *
 *   1. o `window.print()` abre a folha de impressao neste modo de exibicao?
 *      (desde o iOS 27 nao abre quando o app esta INSTALADO, embora abra no
 *      Safari — a chamada executa sem erro e o `beforeprint` nao dispara);
 *   2. o esquema `x-safari-<url>`, usado como contorno, abre o Safari mesmo?
 *      (nao e documentado pela Apple e pode ser ignorado sem aviso);
 *   3. o endereco do documento fica sempre visivel e copiavel — a saida manual
 *      que garante que nenhum usuario fica sem conseguir imprimir.
 *
 * Cada passo mostra o resultado cru na tela, sem inferencia.
 */
function ImpressaoPwa() {
  const [amb, setAmb] = useState<{
    instalado: boolean;
    ios: boolean;
    printApi: boolean;
    url: string;
    alvo: string;
  } | null>(null);
  const [testePrint, setTestePrint] = useState<string | null>(null);
  const [testeSafari, setTesteSafari] = useState<string | null>(null);
  const [copiado, setCopiado] = useState(false);

  useEffect(() => {
    setAmb({
      instalado: estaInstalado(),
      ios: ehIOS(),
      printApi: typeof window.print === "function",
      url: urlDoDocumento().toString(),
      alvo: linkSafari(urlComImpressao()),
    });
  }, []);

  function testarPrint() {
    let abriu = false;
    const ao = () => {
      abriu = true;
    };
    setTestePrint("testando… (a folha de impressão deve abrir agora)");
    window.addEventListener("beforeprint", ao);
    window.print();
    window.setTimeout(() => {
      window.removeEventListener("beforeprint", ao);
      setTestePrint(
        abriu
          ? "✅ abriu a folha de impressão (beforeprint disparou): neste modo o window.print() funciona"
          : "❌ nada abriu e o beforeprint não disparou — é a regressão do iOS 27; aqui o contorno é o passo 2",
      );
    }, 1500);
  }

  function testarSafari() {
    if (!amb) return;
    setTesteSafari("tentando abrir o Safari… (o app deve ir para segundo plano)");
    let saiu = false;
    const parar = aoSairDoApp(() => {
      saiu = true;
    });
    window.location.href = amb.alvo;
    window.setTimeout(() => {
      parar();
      setTesteSafari(
        saiu
          ? "✅ saiu do app — o Safari foi chamado (x-safari- funciona neste iOS)"
          : "❌ o app continuou aberto — x-safari- foi ignorado; o painel manual com o endereço é a saída",
      );
    }, 2000);
  }

  async function copiar() {
    try {
      await navigator.clipboard.writeText(amb?.url ?? "");
      setCopiado(true);
    } catch {
      setCopiado(false);
    }
  }

  return (
    <div className="cartao space-y-3 p-4">
      <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">
        Impressão — botão "Imprimir / PDF"
      </h2>

      {!amb ? (
        <p className="text-sm text-stone-500">Medindo…</p>
      ) : (
        <>
          <div>
            <Linha k="Aberto como PWA?" v={amb.instalado ? "sim (standalone)" : "não (navegador)"} />
            <Linha k="Sistema iOS?" v={amb.ios ? "sim" : "não"} />
            <Linha k="window.print disponível" v={amb.printApi ? "sim" : "não"} />
          </div>

          <p className="rounded-xl bg-nuvem-100 p-2.5 text-xs text-stone-600">
            Rode com o app <b>instalado</b> (ícone da tela de início). No Safari o passo 1 sempre passa — é no PWA que
            ele falha desde o iOS 27.
          </p>
          <p className="rounded-xl bg-nuvem-100 p-2.5 text-xs text-stone-600">
            O Safari do iPhone tem <b>sessão separada</b> do app instalado (cookies isolados por design), por isso o
            botão dos documentos manda o endereço por <code>/login?proximo=…</code>: na primeira vez o Safari pede
            login e devolve você no documento; depois entra direto.
          </p>

          <div className="space-y-2">
            <button
              type="button"
              onClick={testarPrint}
              className="w-full rounded-xl bg-marca-600 px-4 py-2.5 font-semibold text-white"
            >
              1. Testar window.print()
            </button>
            {testePrint && (
              <p role="status" className="rounded-xl bg-nuvem-100 p-2.5 text-sm text-tinta-900">
                {testePrint}
              </p>
            )}

            <button
              type="button"
              onClick={testarSafari}
              className="w-full rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 font-semibold text-tinta-900"
            >
              2. Testar abrir no Safari (x-safari-)
            </button>
            {testeSafari && (
              <p role="status" className="rounded-xl bg-nuvem-100 p-2.5 text-sm text-tinta-900">
                {testeSafari}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-stone-500">
              Endereço do documento (saída manual, sempre disponível)
            </h3>
            <input
              readOnly
              value={amb.url}
              onFocus={(e) => e.currentTarget.select()}
              aria-label="Endereço do documento"
              className="campo text-[0.7rem]"
            />
            <button
              type="button"
              onClick={copiar}
              className="rounded-xl border border-nuvem-300 bg-white px-3 py-2 text-xs font-semibold text-tinta-900"
            >
              {copiado ? "Copiado" : "Copiar endereço"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Linha de leitura usada pelas duas secoes desta pagina. */
function Linha({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-nuvem-200 py-2 last:border-0">
      <span className="text-sm text-stone-500">{k}</span>
      <span className="text-right text-sm font-medium text-tinta-900 break-all">{v}</span>
    </div>
  );
}
