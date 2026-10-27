"use client";
import { useState } from "react";

/** Upload do comprovante (5 MB, JPG/PNG/WEBP/PDF) com feedback do servidor. */
export default function EnviarComprovante({ slug, token }: { slug: string; token: string }) {
  const [status, setStatus] = useState<{ carregando: boolean; ok: boolean; texto: string | null }>({
    carregando: false,
    ok: false,
    texto: null,
  });

  async function enviar(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const arquivo = fd.get("comprovante") as File | null;
    if (!arquivo || arquivo.size === 0) {
      setStatus({ carregando: false, ok: false, texto: "Selecione o arquivo do comprovante." });
      return;
    }
    setStatus({ carregando: true, ok: false, texto: null });
    try {
      const r = await fetch(`/api/loja/${slug}/pedidos/${token}/comprovante`, { method: "POST", body: fd });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.erro || "Não foi possível enviar o comprovante.");
      setStatus({ carregando: false, ok: true, texto: "Comprovante enviado! A locadora vai verificar em breve." });
      // recarrega para exibir o novo estado do pedido
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      setStatus({ carregando: false, ok: false, texto: (err as Error).message });
    }
  }

  return (
    <form onSubmit={enviar} className="space-y-2">
      <input
        type="file"
        name="comprovante"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        className="block w-full text-sm"
        required
      />
      <p className="text-xs opacity-60">JPG, PNG, WEBP ou PDF de até 5 MB.</p>
      <button
        type="submit"
        disabled={status.carregando}
        className="px-4 py-2.5 text-sm font-bold text-white disabled:opacity-60"
        style={{ background: "var(--loja-primary)", borderRadius: "var(--loja-radius)" }}
      >
        {status.carregando ? "Enviando…" : "Enviar comprovante"}
      </button>
      {status.texto && (
        <p className={`text-sm ${status.ok ? "text-emerald-600" : "text-red-600"}`} role="status">
          {status.texto}
        </p>
      )}
    </form>
  );
}
