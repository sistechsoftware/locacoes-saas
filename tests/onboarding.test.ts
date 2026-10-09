/**
 * Onboarding comercial (Etapa 4): checkout público que cria empresa + owner +
 * trial automaticamente. Mesma base dos testes de billing: FakeD1 com todas
 * as migrations e datas em diaBR() (fuso de Brasília, sem tocar no relógio).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { all, one, resetCompanyCache, run, scalar } from "../src/lib/db.ts";

function diaBR(offset: number): string {
  return new Date(Date.now() - 3 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
}

beforeEach(async () => {
  createTestDb();
  resetCompanyCache();
});

describe("validação do cadastro público", () => {
  const base = {
    empresa: "E",
    nome: "A",
    username: "abc",
    senha: "12345678",
    plano: "essencial",
    email: "dono@empresa.com",
    tipo_pessoa: "pf",
    documento: "11144477735", // CPF válido (dígitos verificadores conferidos)
  };

  it("recusa campos obrigatórios vazios ou inválidos", async () => {
    const { validarCadastro } = await import("../src/lib/onboarding.ts");
    assert.ok("erro" in validarCadastro({ ...base, empresa: "" }));
    assert.ok("erro" in validarCadastro({ ...base, nome: "" }));
    assert.ok("erro" in validarCadastro({ ...base, username: "ab" }));
    assert.ok("erro" in validarCadastro({ ...base, senha: "curta" }));
    assert.ok("erro" in validarCadastro({ ...base, plano: "" }));
    assert.ok("erro" in validarCadastro({ ...base, email: "" }), "e-mail é obrigatório (canal dos avisos)");
    assert.ok("erro" in validarCadastro({ ...base, email: "sem-arroba" }));
    assert.ok(!("erro" in validarCadastro({ ...base, username: "Abc.Def-1", plano: "Essencial", email: "Dono@Empresa.COM" })));
  });

  it("exige tipo de pessoa, CPF/CNPJ coerente com o tipo e dígitos verificadores", async () => {
    const { validarCadastro } = await import("../src/lib/onboarding.ts");
    // Tipo de pessoa ausente/lixo: recusado.
    assert.ok("erro" in validarCadastro({ ...base, tipo_pessoa: "" }));
    assert.ok("erro" in validarCadastro({ ...base, tipo_pessoa: "x" }));
    // Documento ausente ou curto: recusado.
    assert.ok("erro" in validarCadastro({ ...base, documento: "" }));
    assert.ok("erro" in validarCadastro({ ...base, documento: "123" }));
    // CPF com dígito verificador errado: recusado (não é só máscara na tela).
    assert.ok("erro" in validarCadastro({ ...base, documento: "11144477736" }));
    assert.ok("erro" in validarCadastro({ ...base, documento: "11111111111" }), "sequência repetida é inválida");
    // PF exige 11 dígitos: um CNPJ em PF é recusado.
    assert.ok("erro" in validarCadastro({ ...base, documento: "11222333000181" }));
    // PJ exige CNPJ válido: CPF em PJ e CNPJ com DV errado são recusados.
    assert.ok("erro" in validarCadastro({ ...base, tipo_pessoa: "pj", documento: "11144477735" }));
    assert.ok("erro" in validarCadastro({ ...base, tipo_pessoa: "pj", documento: "11222333000182" }));
    // Caminhos válidos: PF com CPF e PJ com CNPJ.
    const pf = validarCadastro({ ...base });
    assert.ok(!("erro" in pf), JSON.stringify(pf));
    if (!("erro" in pf)) {
      assert.equal(pf.tipoPessoa, "pf");
      assert.equal(pf.documento, "11144477735", "documento normalizado (só dígitos)");
    }
    const pj = validarCadastro({ ...base, tipo_pessoa: "pj", documento: "11.222.333/0001-81" });
    assert.ok(!("erro" in pj), JSON.stringify(pj));
    if (!("erro" in pj)) {
      assert.equal(pj.tipoPessoa, "pj");
      assert.equal(pj.documento, "11222333000181");
    }
  });
});

describe("criação de empresa + trial via checkout", () => {
  beforeEach(async () => {
    await run(`DELETE FROM companies`);
    await run(`DELETE FROM subscriptions`);
  });

  it("cria empresa nova (id não fixo), owner com e-mail, settings LOC e trial no plano", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");

    const r = await criarEmpresaComTrial({
      empresa: "Locadora Teste",
      nome: "João Dono",
      username: "joao",
      senha: "senha-forte-1",
      plano: "profissional",
      email: "dono@locadorateste.com",
      tipo_pessoa: "pf",
      documento: "529.982.247-25",
    });
    assert.ok(r.ok, `esperava ok: ${JSON.stringify(r)}`);
    if (!r.ok) return;

    // Empresa nova com id auto-increment (a empresa 1 da instalação já existe).
    assert.ok(r.companyId > 1, `companyId deveria ser > 1, veio ${r.companyId}`);

    const user = await one<any>(`SELECT * FROM users WHERE id = ?`, [r.userId]);
    assert.equal(user.company_id, r.companyId);
    assert.equal(user.role, "owner");
    assert.equal(user.platform_admin, 0, "cliente NÃO é operador da plataforma");
    assert.equal(user.email, "dono@locadorateste.com", "owner com e-mail para avisos");
    assert.equal(user.person_type, "pf", "tipo de pessoa persistido");
    assert.equal(user.document, "52998224725", "documento normalizado persistido");
    const empresa = await one<any>(`SELECT email, document FROM companies WHERE id = ?`, [r.companyId]);
    assert.equal(empresa.email, "dono@locadorateste.com");
    assert.equal(empresa.document, null, "PF: o CPF é da pessoa, a empresa não herda documento");
    assert.equal(r.email, "dono@locadorateste.com");

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

    // Pendência #04: a empresa nova nasce com as 12 regras de notificação.
    // Sem isto o cron não acha regra (push cancelled) e a tela de
    // preferências mostra zero regras para este tenant.
    const { REGRAS_PADRAO } = await import("../src/lib/push-rules.ts");
    const regras = await all<{ type: string; enabled: number; offsets: string }>(
      `SELECT type, enabled, offsets FROM notification_rules WHERE company_id = ? ORDER BY type`,
      [r.companyId],
    );
    assert.equal(regras.length, REGRAS_PADRAO.length, "empresa nova ficou sem regras padrão");
    assert.deepEqual(
      regras.map((x) => x.type).sort(),
      REGRAS_PADRAO.map((x) => x.type).sort(),
      "conjunto de regras da empresa nova difere do padrão",
    );
    // As regras da empresa 1 continuam intactas (INSERT OR IGNORE por empresa).
    assert.equal(
      await scalar(`SELECT COUNT(*) FROM notification_rules WHERE company_id = 1`),
      REGRAS_PADRAO.length,
      "onboarding tocou nas regras da empresa 1",
    );
  });

  it("recusa username já usado, plano inativo e empresa ativa com mesmo nome", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");
    const dados = {
      empresa: "Locadora A",
      nome: "Ana",
      username: "ana",
      senha: "senha-forte-1",
      plano: "essencial",
      email: "ana@locadora-a.com",
      tipo_pessoa: "pj",
      documento: "11222333000181", // CNPJ válido
    };

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

  it("recusa documento e e-mail já cadastrados em OUTRA conta (unicidade global)", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");
    const base = {
      empresa: "Locadora Unica",
      nome: "Carla",
      username: "carla",
      senha: "senha-forte-1",
      plano: "essencial",
      email: "carla@unica.com",
      tipo_pessoa: "pf",
      documento: "12345678909", // CPF válido
    };
    const r1 = await criarEmpresaComTrial(base);
    assert.ok(r1.ok, JSON.stringify(r1));

    // Mesmo CPF, outro usuário/e-mail/empresa: recusado pelo documento.
    const r2 = await criarEmpresaComTrial({
      ...base,
      empresa: "Locadora Outra",
      username: "carla2",
      email: "outra@unica.com",
    });
    assert.ok(!r2.ok);
    if (!r2.ok) assert.match(r2.erro, /CPF\/CNPJ já está cadastrado/i);

    // Mesmo e-mail, outro CPF: recusado pelo e-mail.
    const r3 = await criarEmpresaComTrial({
      ...base,
      empresa: "Locadora Terceira",
      username: "carla3",
      documento: "52998224725",
    });
    assert.ok(!r3.ok);
    if (!r3.ok) assert.match(r3.erro, /e-mail já está cadastrado/i);

    // PJ: companies.document nasce espelhado com o CNPJ do responsável.
    const r4 = await criarEmpresaComTrial({
      empresa: "Locadora PJ",
      nome: "Pedro",
      username: "pedro",
      senha: "senha-forte-1",
      plano: "essencial",
      email: "pedro@locadora-pj.com",
      tipo_pessoa: "pj",
      documento: "11.222.333/0001-81",
    });
    assert.ok(r4.ok, JSON.stringify(r4));
    if (r4.ok) {
      const emp = await one<any>(`SELECT document FROM companies WHERE id = ?`, [r4.companyId]);
      assert.equal(emp.document, "11222333000181", "CNPJ espelhado na empresa para a cobrança");
    }
  });

  it("segundo checkout cria OUTRA empresa isolada, cada uma com seu trial", async () => {
    const { criarEmpresaComTrial } = await import("../src/lib/onboarding.ts");
    const a = await criarEmpresaComTrial({ empresa: "Locadora A", nome: "Ana", username: "ana", senha: "senha-forte-1", plano: "essencial", email: "ana@a.com", tipo_pessoa: "pf", documento: "11144477735" });
    const b = await criarEmpresaComTrial({ empresa: "Locadora B", nome: "Bruno", username: "bruno", senha: "senha-forte-2", plano: "empresarial", email: "bruno@b.com", tipo_pessoa: "pj", documento: "00000000000191" });
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
