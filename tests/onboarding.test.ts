/**
 * Onboarding comercial (Etapa 4): checkout público que cria empresa + owner +
 * trial automaticamente. Mesma base dos testes de billing: FakeD1 com todas
 * as migrations e datas em diaBR() (fuso de Brasília, sem tocar no relógio).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { one, resetCompanyCache, run, scalar } from "../src/lib/db.ts";

function diaBR(offset: number): string {
  return new Date(Date.now() - 3 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

beforeEach(async () => {
  createTestDb();
  resetCompanyCache();
});

describe("validação do cadastro público", () => {
  it("recusa campos obrigatórios vazios ou inválidos", async () => {
    const { validarCadastro } = await import("../src/lib/onboarding.ts");
    assert.ok("erro" in validarCadastro({ empresa: "", nome: "A", username: "abc", senha: "12345678", plano: "essencial" }));
    assert.ok("erro" in validarCadastro({ empresa: "E", nome: "", username: "abc", senha: "12345678", plano: "essencial" }));
    assert.ok("erro" in validarCadastro({ empresa: "E", nome: "A", username: "ab", senha: "12345678", plano: "essencial" }));
    assert.ok("erro" in validarCadastro({ empresa: "E", nome: "A", username: "abc", senha: "curta", plano: "essencial" }));
    assert.ok("erro" in validarCadastro({ empresa: "E", nome: "A", username: "abc", senha: "12345678", plano: "" }));
    assert.ok(!("erro" in validarCadastro({ empresa: "E", nome: "A", username: "Abc.Def-1", senha: "12345678", plano: "Essencial" })));
  });
});

describe("criação de empresa + trial via checkout", () => {
  beforeEach(async () => {
    await run(`DELETE FROM companies`);
    await run(`DELETE FROM subscriptions`);
  });

  it("cria empresa nova (id não fixo), owner sem platform_admin, settings LOC e trial no plano", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");

    const r = await criarEmpresaComTrial({
      empresa: "Locadora Teste",
      nome: "João Dono",
      username: "joao",
      senha: "senha-forte-1",
      plano: "profissional",
    });
    assert.ok(r.ok, `esperava ok: ${JSON.stringify(r)}`);
    if (!r.ok) return;

    // Empresa nova com id auto-increment (a empresa 1 da instalação já existe).
    assert.ok(r.companyId > 1, `companyId deveria ser > 1, veio ${r.companyId}`);

    const user = await one<any>(`SELECT * FROM users WHERE id = ?`, [r.userId]);
    assert.equal(user.company_id, r.companyId);
    assert.equal(user.role, "owner");
    assert.equal(user.platform_admin, 0, "cliente NÃO é operador da plataforma");

    const settings = await one<any>(
      `SELECT value FROM company_settings WHERE company_id = ? AND key = 'company_name'`,
      [r.companyId],
    );
    assert.equal(settings.value, "Locadora Teste");
    const prefixo = await one<any>(
      `SELECT value FROM company_settings WHERE company_id = ? AND key = 'doc_prefix_reservations'`,
      [r.companyId],
    );
    assert.equal(prefixo.value, "LOC", "numeração LOC herdada da regra da 0028");

    // Trial: status, plano escolhido e janela de 14 dias em dia corrente.
    const sub = await one<any>(`SELECT * FROM subscriptions WHERE company_id = ?`, [r.companyId]);
    assert.ok(sub);
    assert.equal(sub.status, "trial");
    const plano = await one<any>(`SELECT slug FROM plans WHERE id = ?`, [sub.plan_id]);
    assert.equal(plano.slug, "profissional", "trial nasce no plano do checkout");
    assert.equal(sub.trial_ends_at, diaBR(14));
    assert.equal(sub.current_period_start, diaBR(0));

    // Estado comercial consistente com o gate do layout.
    const { estadoAssinatura } = await import("../src/lib/billing.ts");
    const estado = await estadoAssinatura(r.companyId);
    assert.equal(estado.status, "trial");
    assert.equal(estado.bloqueioDuro, false);
  });

  it("recusa username já usado, plano inativo e empresa ativa com mesmo nome", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");
    const dados = { empresa: "Locadora A", nome: "Ana", username: "ana", senha: "senha-forte-1", plano: "essencial" };

    const r1 = await criarEmpresaComTrial(dados);
    assert.ok(r1.ok);

    const r2 = await criarEmpresaComTrial(dados);
    assert.ok(!r2.ok);
    if (!r2.ok) assert.match(r2.erro, /usuário/i, "username é UNIQUE global");

    const r3 = await criarEmpresaComTrial({ ...dados, username: "ana2", plano: "plano-fantasma" });
    assert.ok(!r3.ok);
    if (!r3.ok) assert.match(r3.erro, /plano/i);

    const r4 = await criarEmpresaComTrial({ ...dados, username: "ana3" });
    assert.ok(!r4.ok);
    if (!r4.ok) assert.match(r4.erro, /empresa/i, "nome de empresa ativa duplicado é recusado");
  });

  it("segundo checkout cria OUTRA empresa isolada, cada uma com seu trial", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");
    const a = await criarEmpresaComTrial({ empresa: "Locadora A", nome: "Ana", username: "ana", senha: "senha-forte-1", plano: "essencial" });
    const b = await criarEmpresaComTrial({ empresa: "Locadora B", nome: "Bruno", username: "bruno", senha: "senha-forte-2", plano: "empresarial" });
    assert.ok(a.ok && b.ok);
    if (!a.ok || !b.ok) return;
    assert.notEqual(a.companyId, b.companyId);

    assert.equal(await scalar(`SELECT COUNT(*) FROM subscriptions`), 2, "uma assinatura por empresa");
    assert.equal(
      await scalar(`SELECT COUNT(*) FROM company_settings WHERE key = 'doc_prefix_reservations' AND value = 'LOC'`),
      2,
    );

    // O gate do layout usa o company_id da sessão: nada vaza entre empresas.
    const { estadoAssinatura } = await import("../src/lib/billing.ts");
    const ea = await estadoAssinatura(a.companyId);
    const eb = await estadoAssinatura(b.companyId);
    assert.equal(ea.status, "trial");
    assert.equal(eb.status, "trial");
  });
});
