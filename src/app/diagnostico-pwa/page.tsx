"use client";

import { useEffect, useState } from "react";

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

  const Linha = ({ k, v }: { k: string; v: React.ReactNode }) => (
    <div className="flex items-start justify-between gap-3 border-b border-nuvem-200 py-2 last:border-0">
      <span className="text-sm text-stone-500">{k}</span>
      <span className="text-right text-sm font-medium text-tinta-900 break-all">{v}</span>
    </div>
  );

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

          <div className="cartao p-4 text-xs text-stone-500 break-all">
            <h2 className="mb-2 text-sm font-bold uppercase tracking-wide text-stone-500">User agent</h2>
            {r.ua}
          </div>
        </>
      )}
    </main>
  );
}
