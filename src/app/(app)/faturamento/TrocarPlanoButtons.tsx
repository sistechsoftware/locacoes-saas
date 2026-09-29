"use client";
import { useTransition } from "react";
import { trocarPlanoAction } from "./actions";

export default function TrocarPlanoButtons({ slug }: { slug: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => start(async () => { await trocarPlanoAction(slug); })}
      className="mt-3 w-full rounded-xl border border-marca-300 bg-white px-3 py-2 text-sm font-semibold text-marca-700 transition hover:bg-marca-50 disabled:opacity-60"
    >
      {pending ? "Alterando…" : "Trocar para este plano"}
    </button>
  );
}
