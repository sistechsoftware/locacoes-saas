"use client";
import { useEffect, useRef, useState } from "react";

/**
 * Aceite e assinatura desenhada.
 *
 * Feita para o celular, porque o link chega pelo WhatsApp: area de toque
 * grande, botoes grandes e nenhum cadastro. O desenho vira PNG e vai para o
 * servidor, que revalida tudo antes de gravar.
 */
export default function PainelAssinatura({ token, nomeSugerido }: { token: string; nomeSugerido: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const desenhando = useRef(false);
  const [temTraco, setTemTraco] = useState(false);
  const [aceite, setAceite] = useState(false);
  const [nome, setNome] = useState(nomeSugerido);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState("");
  const [pronto, setPronto] = useState(false);

  // o canvas precisa da resolucao real do aparelho, senao o traco sai borrado
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const escala = window.devicePixelRatio || 1;
    const largura = canvas.clientWidth;
    const altura = canvas.clientHeight;
    canvas.width = largura * escala;
    canvas.height = altura * escala;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(escala, escala);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
  }, []);

  const ponto = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const comecar = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const p = ponto(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    desenhando.current = true;
  };

  const mover = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!desenhando.current) return;
    e.preventDefault();
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const p = ponto(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    if (!temTraco) setTemTraco(true);
  };

  const parar = () => {
    desenhando.current = false;
  };

  const limpar = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setTemTraco(false);
  };

  async function assinar() {
    if (!canvasRef.current) return;
    if (!window.confirm("Tem certeza que deseja assinar este contrato?")) return;
    setEnviando(true);
    setErro("");
    try {
      const resposta = await fetch("/api/assinar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          nome,
          aceite,
          imagem: canvasRef.current.toDataURL("image/png"),
        }),
      });
      const dados = (await resposta.json()) as { ok?: boolean; erro?: string };
      if (!resposta.ok || !dados.ok) throw new Error(dados.erro || "Não foi possível assinar.");
      setPronto(true);
    } catch (e) {
      setErro(e instanceof Error ? e.message : "Falha de conexão. Tente novamente.");
    } finally {
      setEnviando(false);
    }
  }

  if (pronto) {
    return (
      <section className="cartao p-5 text-center">
        <p className="text-2xl">✓</p>
        <h2 className="mt-1 text-base font-bold text-tinta-900">Contrato assinado com sucesso</h2>
        <p className="mt-1 text-sm text-stone-600">
          {new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}
        </p>
        <p className="mt-3 text-sm text-stone-600">
          Uma cópia ficou registrada com a empresa. Você pode fechar esta página.
        </p>
      </section>
    );
  }

  return (
    <section className="cartao space-y-4 p-4">
      <label className="flex items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={aceite}
          onChange={(e) => setAceite(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0"
        />
        <span className="font-semibold text-tinta-900">Li e concordo com os termos do contrato.</span>
      </label>

      <label className="block text-sm">
        <span className="mb-1 block font-semibold text-tinta-900">Nome de quem assina</span>
        <input
          value={nome}
          onChange={(e) => setNome(e.target.value)}
          maxLength={120}
          className="w-full rounded-xl border border-nuvem-300 px-3 py-3 text-base outline-none"
        />
      </label>

      <div>
        <span className="mb-1 block text-sm font-semibold text-tinta-900">Assinatura</span>
        <canvas
          ref={canvasRef}
          onPointerDown={comecar}
          onPointerMove={mover}
          onPointerUp={parar}
          onPointerLeave={parar}
          className="h-44 w-full touch-none rounded-xl border-2 border-dashed border-nuvem-300 bg-white"
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-xs text-stone-500">Assine com o dedo, o mouse ou a caneta.</span>
          <button type="button" onClick={limpar} className="text-sm font-semibold text-marca-600">
            Limpar
          </button>
        </div>
      </div>

      {erro && <p className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{erro}</p>}

      <button
        type="button"
        onClick={assinar}
        disabled={!aceite || !temTraco || nome.trim().length < 3 || enviando}
        className="w-full rounded-xl bg-marca-600 px-4 py-4 text-base font-bold text-white disabled:opacity-50"
      >
        {enviando ? "Assinando…" : "Assinar Contrato"}
      </button>
      {!aceite && <p className="text-center text-xs text-stone-500">Marque o aceite para liberar a assinatura.</p>}
    </section>
  );
}
