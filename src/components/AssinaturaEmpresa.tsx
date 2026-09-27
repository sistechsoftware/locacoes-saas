"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { Badge, Alerta } from "@/components/ui";
import { removeCompanySignature, saveCompanySignature } from "@/app/(app)/configuracoes/actions";

/**
 * Assinatura digital da empresa (aba Assinatura, em Configurações).
 *
 * Mesmo padrao tecnico da assinatura do cliente (PainelAssinatura): canvas com
 * resolucao do aparelho, traco por Pointer Events (dedo, mouse e caneta), PNG
 * via toDataURL e validacao de novo no servidor. E independente dela: o fluxo
 * publico de assinatura de contratos nao e tocado.
 *
 * Erro de salvamento volta como string da server action e e exibido sem
 * limpar o desenho — o proprietario nao perde o traco.
 */
export default function AssinaturaEmpresa({
  url,
  atualizadaEm,
}: {
  url: string | null;
  atualizadaEm: string | null;
}) {
  const [erro, action] = useActionState(saveCompanySignature, null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const desenhando = useRef(false);
  const [temTraco, setTemTraco] = useState(false);
  const [editando, setEditando] = useState(false);

  // existe assinatura e o usuario pediu para trocar: abre o canvas em branco
  const modoDesenho = !url || editando;

  // depois de salvar, a revalidacao troca a url (arquivo novo): sai do modo
  // desenho e mostra a previa. Erro de salvamento nao muda a url, entao o
  // usuario continua com o desenho na tela.
  const urlAnterior = useRef(url);
  useEffect(() => {
    if (urlAnterior.current !== url) {
      urlAnterior.current = url;
      if (url) {
        setEditando(false);
        setTemTraco(false);
      }
    }
  }, [url]);

  // o canvas precisa da resolucao real do aparelho, senao o traco sai borrado
  useEffect(() => {
    if (!modoDesenho) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const escala = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * escala;
    canvas.height = canvas.clientHeight * escala;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(escala, escala);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0f172a";
  }, [modoDesenho]);

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

  /**
   * Grava o desenho: o PNG vai como campo oculto do formulario, para a server
   * action validar e salvar. A confirmacao antes de salvar e exigida aqui
   * (mesmo padrao de window.confirm do fluxo do cliente).
   */
  function aoEnviar(fd: FormData) {
    const canvas = canvasRef.current;
    if (canvas) fd.set("signature_image", canvas.toDataURL("image/png"));
    action(fd);
  }

  if (!modoDesenho) {
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="rounded-xl border border-nuvem-300 bg-white px-4 py-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url ?? ""} alt="Assinatura da empresa" className="h-24 max-w-full object-contain" />
          </div>
          <div className="space-y-1">
            <Badge tone="verde">Assinatura cadastrada</Badge>
            <p className="text-xs text-stone-500">
              Cadastrada em {atualizadaEm ? new Date(atualizadaEm.replace(" ", "T")).toLocaleString("pt-BR") : "—"}
              {" · "}usada automaticamente em novos contratos e recibos.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => {
              setTemTraco(false);
              setEditando(true);
            }}
            className="rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold text-tinta-900 hover:bg-nuvem-50"
          >
            Alterar assinatura
          </button>
          {/* form proprio: o formAction so dispara com o botao dentro de um form */}
          <form action={removeCompanySignature}>
            <SubmitButton variant="perigo" confirm="Remover a assinatura da empresa? Novos contratos e recibos voltarão a sair sem a assinatura.">
              Remover assinatura
            </SubmitButton>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {url && (
        <Alerta tone="azul">
          Você está criando uma nova assinatura. Ela substitui a atual somente depois de salvar.
        </Alerta>
      )}
      <span className="block text-sm font-semibold text-tinta-900">Desenhe a assinatura</span>
      <canvas
        ref={canvasRef}
        onPointerDown={comecar}
        onPointerMove={mover}
        onPointerUp={parar}
        onPointerLeave={parar}
        className="h-44 w-full touch-none rounded-xl border-2 border-dashed border-nuvem-300 bg-white"
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-stone-500">Assine com o dedo, o mouse ou a caneta.</span>
        <button type="button" onClick={limpar} className="text-sm font-semibold text-marca-600">
          Limpar
        </button>
      </div>

      {erro && <p className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">{erro}</p>}

      <div className="flex flex-wrap gap-2">
        <form action={aoEnviar} className="contents">
          <SubmitButton disabled={!temTraco} confirm="Salvar esta assinatura como a assinatura da empresa?">
            Salvar assinatura
          </SubmitButton>
        </form>
        {url && (
          <button
            type="button"
            onClick={() => setEditando(false)}
            className="rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold text-tinta-900 hover:bg-nuvem-50"
          >
            Cancelar
          </button>
        )}
      </div>
      {!temTraco && <p className="text-xs text-stone-500">Desenhe a assinatura para liberar o salvamento.</p>}
    </div>
  );
}
