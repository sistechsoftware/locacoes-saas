"use client";
import { portalSairAction } from "./actions";

/** Sair: apaga a sessao do portal no servidor e o cookie. */
export default function PortalSairButton() {
  return (
    <form action={portalSairAction}>
      <button
        type="submit"
        className="rounded-xl border border-white/25 bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-white/20"
      >
        Sair
      </button>
    </form>
  );
}
