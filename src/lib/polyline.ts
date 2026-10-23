/**
 * Codificacao de polyline do Google (algorithm overview), precisao 5.
 *
 * OSRM e Routes API devolvem a geometria da rota como polyline codificada.
 * Decodificar no servidor permite normalizar/formatar; decodificar no navegador
 * desenha o trajeto REAL no mapa sem trafegar GeoJSON gigante.
 */

type Ponto = [number, number];

/** Decodifica uma polyline codificada em pares [lat, lon]. */
export function decodePolyline(encoded: string, precision = 5): Ponto[] {
  const factor = 10 ** precision;
  const pontos: Ponto[] = [];
  let index = 0, lat = 0, lng = 0;

  while (index < encoded.length) {
    let result = 1, shift = 0, byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1; shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63 - 1;
      result += byte << shift;
      shift += 5;
    } while (byte >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    pontos.push([lat / factor, lng / factor]);
  }
  return pontos;
}

/** Codifica pares [lat, lon] em polyline (usada quando o provedor devolve GeoJSON). */
export function encodePolyline(pontos: Ponto[], precision = 5): string {
  const factor = 10 ** precision;
  let output = "";
  let prevLat = 0, prevLng = 0;

  for (const [lat, lng] of pontos) {
    const iLat = Math.round(lat * factor);
    const iLng = Math.round(lng * factor);
    output += encodeSigned(iLat - prevLat);
    output += encodeSigned(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return output;
}

function encodeSigned(value: number): string {
  let v = value < 0 ? ~(value << 1) : value << 1;
  let out = "";
  while (v >= 0x20) {
    out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
    v >>= 5;
  }
  return out + String.fromCharCode(v + 63);
}
