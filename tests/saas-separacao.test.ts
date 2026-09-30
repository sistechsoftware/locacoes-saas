/**
 * Separação dos ambientes: destino pós-login pelo perfil e guarda do /saas.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

describe("destinoAposLogin", () => {
  it("administrador da plataforma vai para /saas; locador para /dashboard", async () => {
    // Função pura em destino.ts (auth.ts reexporta, mas puxa next/headers).
    const { destinoAposLogin } = await import("../src/lib/destino.ts");
    assert.equal(destinoAposLogin({ platform_admin: true }), "/saas");
    assert.equal(destinoAposLogin({ platform_admin: false }), "/dashboard");
  });
});

describe("navegação do ambiente SaaS (nav.ts)", () => {
  it("não contém nenhum item operacional (reservas/estoque/agenda)", async () => {
    const { SAAS_NAV, MOBILE_SAAS_NAV, NAV } = await import("../src/lib/nav.ts");
    const proibidos = ["/reservas", "/estoque", "/agenda", "/clientes/", "/orcamentos", "/financeiro/"];
    for (const n of SAAS_NAV) {
      for (const p of proibidos) {
        assert.ok(!n.href.startsWith(p), `item operacional ${n.href} não deveria estar no menu SaaS`);
      }
    }
    assert.ok(SAAS_NAV.some((n) => n.href === "/saas"));
    assert.equal(MOBILE_SAAS_NAV.length, SAAS_NAV.length);
    // A navegação operacional permanece intacta (dashboard, reservas, agenda...).
    assert.ok(NAV.some((n) => n.href === "/dashboard"));
    assert.ok(NAV.some((n) => n.href === "/reservas"));
  });
});
