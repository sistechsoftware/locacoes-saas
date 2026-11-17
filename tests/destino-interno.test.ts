/**
 * `destinoInterno` e o guarda do `?proximo=` do login — o caminho que fecha a
 * impressao no iPhone (documento aberto no Safari volta para a propria pagina
 * depois de autenticar). Ele alimenta um `redirect()`, entao precisa recusar
 * qualquer coisa que saia do site ou volte para o login.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { destinoInterno } from "../src/lib/destino.ts";

const PADRAO = "/dashboard";

describe("destinoInterno (volta do login)", () => {
  it("aceita caminho interno com query — exatamente o caso da impressão", () => {
    assert.equal(
      destinoInterno("/reservas/12/imprimir?imprimir=1", PADRAO),
      "/reservas/12/imprimir?imprimir=1",
    );
    assert.equal(destinoInterno("/recibos/3", PADRAO), "/recibos/3");
  });

  it("recusa host externo, esquema e caminho relativo", () => {
    for (const v of [
      "https://exemplo-malicioso.example/",
      "//exemplo-malicioso.example/x",
      "javascript:alert(1)",
      "reservas/1",
      "/\\exemplo-malicioso.example",
      "/reservas/1\nLocation: https://exemplo-malicioso.example",
    ]) {
      assert.equal(destinoInterno(v, PADRAO), PADRAO, `deveria recusar: ${JSON.stringify(v)}`);
    }
  });

  it("recusa voltar para as telas de autenticação (evita laço)", () => {
    for (const v of ["/login", "/login?proximo=/x", "/redefinir-senha/abc", "/recuperar-senha"]) {
      assert.equal(destinoInterno(v, PADRAO), PADRAO, `deveria recusar: ${v}`);
    }
  });

  it("ausente, vazio ou gigante cai no padrão", () => {
    assert.equal(destinoInterno(null, PADRAO), PADRAO);
    assert.equal(destinoInterno(undefined, PADRAO), PADRAO);
    assert.equal(destinoInterno("", PADRAO), PADRAO);
    assert.equal(destinoInterno("/" + "a".repeat(500), PADRAO), PADRAO);
  });
});
