"use client";
import { useEffect, useRef, useState } from "react";
import { money } from "@/lib/format";
import type { RoadRoute } from "@/lib/routes";
import type { TipoFrete } from "@/lib/freight";

export default function RouteEstimate({ tipo, origin = "", destination, onApply }: {
  tipo: TipoFrete; origin?: string; destination: string; onApply: (value: string) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [route, setRoute] = useState<RoadRoute | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setRoute(null); setError(""); setBusy(false); }, [tipo, origin, destination, enabled]);
  async function calculate() {
    const version = ++generation.current;
    setBusy(true); setError(""); setRoute(null);
    try {
      const response = await fetch("/api/routes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tipo, origin, destination }) });
      const data = await response.json() as RoadRoute & { error?: string };
      if (!response.ok) throw new Error(data.error || "Não foi possível calcular.");
      if (version === generation.current) setRoute(data);
    } catch (e) { if (version === generation.current) setError(e instanceof Error ? e.message : "Falha de conexão."); }
    finally { if (version === generation.current) setBusy(false); }
  }
  return <div className="rounded-xl border border-nuvem-300 bg-nuvem-50 p-3 space-y-2">
    <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} /> Calcular frete por endereço</label>
    {enabled && <>
      <p className="text-xs text-stone-600">{tipo === "comum" ? "Base → coleta → destino → base (3 trechos)." : "Base → evento → base (2 trechos, uma ida e volta). O cálculo manual de entrega e retirada continua separado."} O valor só muda ao aplicar a sugestão; você pode ajustá-lo depois.</p>
      <p className="text-xs text-stone-500">Informe rua, número, cidade e estado. Ao alterar um endereço, calcule novamente. Endereços serão enviados aos serviços públicos OSM/OSRM, sem dados do cliente. Serviço sem garantia de disponibilidade.</p>
      <button type="button" disabled={busy} onClick={calculate} className="rounded-lg bg-marca-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{busy ? "Calculando rota…" : "Calcular rota"}</button>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      {route && <div aria-live="polite" className="space-y-2 text-sm">
        {route.legsKm.map((km, i) => <p key={i}>{route.labels[i]} → {route.labels[i+1]}: <b>{km.toFixed(1)} km</b></p>)}
        <p>Total: <b>{route.totalKm.toFixed(1)} km</b> · Sugestão: <b>{money(route.suggestedCents)}</b></p>
        <button type="button" onClick={() => onApply((route.suggestedCents/100).toFixed(2))} className="rounded-lg border border-marca-600 px-3 py-2 font-semibold">Aplicar Valor Sugerido</button>
      </div>}
      <p className="text-xs text-stone-500">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer" className="underline">OpenStreetMap contributors</a> · Rotas OSRM / FOSSGIS · <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer" className="underline">Corrigir o mapa</a> · <a href="https://operations.osmfoundation.org/policies/nominatim/" target="_blank" rel="noreferrer" className="underline">Limites de uso (sem autocomplete)</a>.</p>
    </>}
  </div>;
}
