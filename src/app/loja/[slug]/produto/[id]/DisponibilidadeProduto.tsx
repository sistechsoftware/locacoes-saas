"use client";
import { useState } from "react";

/**
 * Consulta de disponibilidade para uma data: leitura informativa calculada no
 * servidor com a mesma regra do painel. A garantia real acontece na submissão
 * e na aprovação — aqui o cliente só sabe se convém tentar.
 */
export default function DisponibilidadeProduto({ slug, productId }: { slug: string; productId: number }) {
  const [data, setData] = useState("");
  const [estado, setEstado] = useState<{ carregando: boolean; texto: string | null; erro: boolean }>({
    carregando: false,
    texto: null,
    erro: false,
  });

  async function consultar() {
    if (!data) return;
    setEstado({ carregando: true, texto: null, erro: false });
    try {
      const r = await fetch(`/api/loja/${slug}/disponibilidade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ product_ids: [productId], event_date: data }),
      });
      const j: any = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.erro || "Não foi possível consultar.");
      const item = j.itens?.[0];
      setEstado({
        carregando: false,
        erro: false,
        texto:
          !item || item.available <= 0
            ? "Indisponível nesta data."
            : `Disponível: ${item.available} un. nesta data (sujeito a confirmação no envio).`,
      });
    } catch (e) {
      setEstado({ carregando: false, erro: true, texto: (e as Error).message });
    }
  }

  return (
    <div className="rounded-xl border p-3 text-sm" style={{ borderColor: "var(--loja-accent)", background: "var(--loja-card)" }}>
      <p className="mb-2 font-semibold">Consultar disponibilidade</p>
      <div className="flex flex-wrap gap-2">
        <input
          type="date"
          value={data}
          onChange={(e) => setData(e.target.value)}
          className="rounded-lg border px-3 py-2"
          style={{ borderColor: "var(--loja-secondary)", color: "var(--loja-text)", background: "var(--loja-bg)" }}
          aria-label="Data desejada"
        />
        <button
          type="button"
          onClick={consultar}
          disabled={estado.carregando || !data}
          className="px-4 py-2 font-bold text-white disabled:opacity-50"
          style={{ background: "var(--loja-primary)", borderRadius: "var(--loja-radius)" }}
        >
          {estado.carregando ? "Consultando…" : "Consultar"}
        </button>
      </div>
      {estado.texto && (
        <p className={`mt-2 ${estado.erro ? "text-red-600" : ""}`} style={estado.erro ? {} : { color: "var(--loja-secondary)" }}>
          {estado.texto}
        </p>
      )}
    </div>
  );
}
