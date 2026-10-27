"use client";
import { useState } from "react";

/** Copia o link público da loja para a área de transferência. */
export default function CopiarLink({ href }: { href: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <button
      type="button"
      className="rounded-xl border border-nuvem-300 bg-white px-3 py-2 text-sm font-semibold text-tinta-900 hover:bg-nuvem-50"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(href);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        } catch {
          // clipboard bloqueado: o link fica visível na caixa ao lado
        }
      }}
    >
      {copiado ? "Copiado ✓" : "Copiar link"}
    </button>
  );
}
