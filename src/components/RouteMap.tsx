"use client";
import { useEffect, useRef, useState } from "react";
import { decodePolyline } from "@/lib/polyline";

/**
 * Mapa da rota calculada, com a geometria RETORNADA pelo serviço de
 * roteamento (polyline codificada) — nunca uma linha reta desenhada à mão.
 *
 * Renderiza no Google Maps JavaScript API (chave pública restrita por
 * origem, GOOGLE_MAPS_CLIENT_KEY): é o mesmo provedor das rotas quando
 * configurado, com atribuição automática exigida pelos termos do Google.
 * Todas as alternativas retornadas são desenhadas; a selecionada ganha
 * destaque, e clicar numa alternativa no mapa troca a rota (lista, mapa e
 * valor do frete ficam sincronizados).
 */

export type RotaMapa = { index: number; geometry: string; totalKm: number };
type PontoMapa = { label: string; lat: number; lon: number };

const COR_SELECIONADA = "#7c3aed";
const COR_ALTERNATIVA = "#64748b";

let carregamento: Promise<void> | null = null;

function carregarGoogleMaps(chave: string): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  const w = window as unknown as { google?: { maps?: unknown } };
  if (w.google?.maps) return Promise.resolve();
  if (!carregamento) {
    carregamento = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(chave)}&language=pt-BR&v=weekly`;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => { carregamento = null; reject(new Error("Falha ao carregar o mapa.")); };
      document.head.appendChild(script);
    });
  }
  return carregamento;
}

type GoogleMaps = {
  maps: {
    Map: new (el: HTMLElement, opts: Record<string, unknown>) => { fitBounds: (b: unknown) => void; setOptions: (o: Record<string, unknown>) => void };
    Marker: new (opts: Record<string, unknown>) => { setMap: (m: unknown) => void };
    Polyline: new (opts: Record<string, unknown>) => { setMap: (m: unknown) => void; addListener: (ev: string, cb: () => void) => void };
    LatLngBounds: new () => { extend: (p: { lat: number; lng: number }) => void };
  };
};

export default function RouteMap({
  chave,
  origem,
  destino,
  rotas,
  selecionada,
  onSelect,
}: {
  chave: string;
  origem: PontoMapa;
  destino: PontoMapa;
  rotas: RotaMapa[];
  selecionada: number;
  onSelect: (index: number) => void;
}) {
  const div = useRef<HTMLDivElement | null>(null);
  const mapa = useRef<GoogleMaps["maps"] | null>(null);
  const instancia = useRef<{ fitBounds: (b: unknown) => void } | null>(null);
  const overlays = useRef<Array<{ setMap: (m: unknown) => void }>>([]);
  const [erro, setErro] = useState("");
  const [carregando, setCarregando] = useState(true);
  // Guarda a última seleção para o clique no mapa não disparar loop de efeito.
  const selecionadaRef = useRef(selecionada);
  selecionadaRef.current = selecionada;

  useEffect(() => {
    let vivo = true;
    setCarregando(true);
    setErro("");
    carregarGoogleMaps(chave)
      .then(() => { if (vivo) setCarregando(false); })
      .catch(() => { if (vivo) { setErro("Não foi possível carregar o mapa."); setCarregando(false); } });
    return () => { vivo = false; };
  }, [chave]);

  useEffect(() => {
    const g = (window as unknown as { google?: GoogleMaps })?.google;
    if (!g?.maps || !div.current || carregando || erro) return;
    const maps = g.maps;
    mapa.current = maps;
    if (!instancia.current) {
      instancia.current = new maps.Map(div.current, {
        center: { lat: origem.lat, lng: origem.lon },
        zoom: 8,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false,
      });
    }
    const map = instancia.current as unknown as object;

    // limpa overlays anteriores antes de redesenhar
    for (const o of overlays.current) o.setMap(null);
    overlays.current = [];

    const bounds = new maps.LatLngBounds();
    const desenhadas = rotas.filter(r => r.geometry);
    for (const rota of rotas) {
      if (!rota.geometry) continue;
      const pontos = decodePolyline(rota.geometry).map(([lat, lon]) => ({ lat, lng: lon }));
      if (!pontos.length) continue;
      const ativa = rota.index === selecionada;
      const linha = new maps.Polyline({
        path: pontos,
        strokeColor: ativa ? COR_SELECIONADA : COR_ALTERNATIVA,
        strokeOpacity: ativa ? 1 : 0.55,
        strokeWeight: ativa ? 6 : 3,
        zIndex: ativa ? 2 : 1,
        clickable: true,
        geodesic: true,
      });
      linha.addListener("click", () => { if (!ativa) onSelect(rota.index); });
      linha.setMap(map);
      overlays.current.push(linha);
      if (ativa || desenhadas.length === 1) for (const p of pontos) bounds.extend(p);
    }
    if (!desenhadas.some(r => r.index === selecionada)) {
      for (const r of desenhadas) {
        for (const [lat, lon] of decodePolyline(r.geometry)) bounds.extend({ lat, lng: lon });
      }
    }

    const marcadorOrigem = new maps.Marker({ position: { lat: origem.lat, lng: origem.lon }, title: `Origem: ${origem.label}`, map });
    const marcadorDestino = new maps.Marker({ position: { lat: destino.lat, lng: destino.lon }, title: `Destino: ${destino.label}`, map });
    overlays.current.push(marcadorOrigem, marcadorDestino);
    bounds.extend({ lat: origem.lat, lng: origem.lon });
    bounds.extend({ lat: destino.lat, lng: destino.lon });
    instancia.current.fitBounds(bounds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave, carregando, erro, origem.lat, origem.lon, destino.lat, destino.lon, rotas, selecionada, onSelect]);

  if (erro) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl border border-nuvem-300 bg-nuvem-50 px-4 text-center text-sm text-red-700" role="alert">
        {erro}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <div
        ref={div}
        aria-label="Mapa da rota calculada"
        className={`h-72 w-full rounded-xl border border-nuvem-300 sm:h-96 ${carregando ? "animate-pulse bg-nuvem-100" : ""}`}
      />
      {carregando && <p aria-live="polite" className="text-xs text-stone-500">Carregando mapa…</p>}
      {!carregando && (
        <p className="text-xs text-stone-500">
          Traçado do serviço de roteamento. {rotas.length > 1 ? "Clique numa linha alternativa para selecioná-la." : "Rota única disponível."} © Google Maps
        </p>
      )}
    </div>
  );
}
