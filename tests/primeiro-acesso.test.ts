/**
 * Primeiro acesso (/setup): criação do owner da plataforma com E-MAIL
 * obrigatório — canal dos avisos (trial, cobrança) e da recuperação de senha.
 * Mesma base dos testes de onboarding: FakeD1 com todas as migrations.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { one, resetCompanyCache, scalar } from "../src/lib/db.ts";

beforeEach(async () => {
  createTestDb();
  resetCompanyCache();
});

describe("criarPrimeiroOwner (setup com e-mail)", () => {
  const base = { empresa: "Minha Locadora", nome: "Uericlis", username: "ericlis", senha: "senha-forte-1" };

  it("exige e-mail válido (canal dos avisos e da recuperação de senha)", async () => {
    const { criarPrimeiroOwner } = await import("../src/lib/primeiro-acesso.ts");
    assert.match((await criarPrimeiroOwner({ ...base, email: "" }) as any).erro, /e-mail/i);
    assert.match((await criarPrimeiroOwner({ ...base, email: "sem-arroba" }) as any).erro, /E-mail inv/i);
  });

  it("cria owner platform_admin com e-mail em users e companies", async () => {
    const { criarPrimeiroOwner } = await import("../src/lib/primeiro-acesso.ts");
    const r = await criarPrimeiroOwner({
      ...base,
      email: "Dono@Locadora.com",
    });
    assert.ok(r.ok, `esperava ok: ${JSON.stringify(r)}`);
    if (!r.ok) return;
    assert.equal(r.email, "dono@locadora.com", "e-mail normalizado em minúsculas");

    const user = await one<any>(`SELECT * FROM users WHERE id = ?`, [r.userId]);
    assert.equal(user.platform_admin, 1, "primeiro acesso é operador da plataforma");
    assert.equal(user.role, "owner");
    assert.equal(user.email, "dono@locadora.com");

    const empresa = await one<any>(`SELECT email FROM companies WHERE id = 1`);
    assert.equal(empresa.email, "dono@locadora.com", "companies.email é o canal comercial");

    const nome = await scalar<string | null>(
      `SELECT value FROM company_settings WHERE company_id = 1 AND key = 'company_name'`,
    );
    assert.equal(nome, "Minha Locadora");
  });

  it("recusa o segundo cadastro: instalação deixa de estar vazia", async () => {
    const { criarPrimeiroOwner } = await import("../src/lib/primeiro-acesso.ts");
    const r1 = await criarPrimeiroOwner({ ...base, email: "a@locadora.com" });
    assert.ok(r1.ok);
    const r2 = await criarPrimeiroOwner({ ...base, username: "segundo", email: "b@locadora.com" });
    assert.ok(!r2.ok);
    assert.match((r2 as any).erro, /já possui um acesso/);
  });
});
