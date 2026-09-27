"use client";
import { BTN } from "@/components/ui";

/** Imprimir ou salvar em PDF usa o dialogo nativo do navegador. */
export default function PrintButton() {
  return (
    <button type="button" onClick={() => window.print()} className={BTN.primario}>
      Imprimir / PDF
    </button>
  );
}
