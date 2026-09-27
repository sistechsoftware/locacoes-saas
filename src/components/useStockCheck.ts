"use client";
import { useEffect, useState } from "react";
import { windowError } from "@/lib/availability-time";
import { checkStock, type ItemInput } from "@/app/(app)/reservas/actions";

/** Debounced, cancellation-safe query shared by quotes and reservations. */
export function useStockCheck(items: ItemInput[], from: string, to: string, considerPreparation: boolean, excludeId?: number | null) {
  const [state, setState] = useState<{ key: string; conflicts: any[]; error: string | null; checking: boolean }>({ key: "", conflicts: [], error: null, checking: false });
  const key = JSON.stringify({ items, from, to, considerPreparation, excludeId });
  useEffect(() => {
    let active = true;
    const invalid = windowError(from, to);
    if (!items.length || invalid) {
      setState({ key, conflicts: [], error: items.length ? invalid : null, checking: false });
      return;
    }
    setState({ key, conflicts: [], error: null, checking: true });
    const timer = setTimeout(async () => {
      try {
        const conflicts = await checkStock(JSON.parse(key));
        if (active) setState({ key, conflicts, error: null, checking: false });
      } catch {
        if (active) setState({ key, conflicts: [], error: "Não foi possível verificar o estoque. Tente novamente; a gravação sempre refaz a verificação.", checking: false });
      }
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [key, items.length, from, to]);
  return state.key === key ? state : { conflicts: [], error: null, checking: true };
}
