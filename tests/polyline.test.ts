import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decodePolyline, encodePolyline } from "../src/lib/polyline";

describe("polyline", () => {
  it("decodifica um exemplo conhecido do Google", () => {
    // Exemplo clássico da documentação do Google Maps (precision 5).
    const pontos = decodePolyline("_p~iF~ps|U_ulLnnqC_mqNvxq`@");
    assert.equal(pontos.length, 3);
    assert.deepEqual(pontos[0].map(n => Math.round(n * 1000) / 1000), [38.5, -120.2]);
    assert.deepEqual(pontos[1].map(n => Math.round(n * 1000) / 1000), [40.7, -120.95]);
    assert.deepEqual(pontos[2].map(n => Math.round(n * 1000) / 1000), [43.252, -126.453]);
  });

  it("ida e volta preservam coordenadas (round trip)", () => {
    const trajeto: [number, number][] = [
      [-18.9185, -48.9409], [-19.0, -47.5], [-19.9167, -43.9386],
    ];
    const codificada = encodePolyline(trajeto);
    const decodificada = decodePolyline(codificada);
    assert.equal(decodificada.length, 3);
    for (const [i, [lat, lon]] of trajeto.entries()) {
      assert.ok(Math.abs(decodificada[i][0] - lat) < 1e-5, `lat do ponto ${i}`);
      assert.ok(Math.abs(decodificada[i][1] - lon) < 1e-5, `lon do ponto ${i}`);
    }
  });

  it("geometria vazia não vira traçado", () => {
    assert.deepEqual(decodePolyline(""), []);
  });
});
