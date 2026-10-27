"use client";
import { useState } from "react";

/** Botão de copiar (chave Pix, código copia-e-cola, link). */
export default function CopiarTexto({ valor, rotulo = "Copiar" }: { valor: string; rotulo?: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <button
      type="button"
      className="px-3 py-1.5 text-xs font-bold text-white"
      style={{ background: "var(--loja-primary)", borderRadius: "var(--loja-radius)" }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(valor);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        } catch {
          setCopiado(false);
        }
      }}
    >
      {copiado ? "Copiado ✓" : rotulo}
    </button>
  );
}
