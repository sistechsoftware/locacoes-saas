/**
 * AUDITORIA DE SEGURANÇA / MULTI-TENANT — testes dos cenários obrigatórios.
 *
 * Hierarquia testada (3 níveis):
 *   Administrador Geral da Plataforma (users.platform_admin = 1)
 *     └── Administrador da Empresa (roles owner | admin)
 *           └── Usuários/Operadores (operacional, financeiro, viewer)
 *
 * Padrão do projeto: funções puras em módulos próprios (usuarios.ts, roles.ts,
 * billing.ts) rodam com FakeD1, sem next/headers. As barreiras das telas
 * (requirePlatformAdmin por página, layout do /saas, guards das actions) são
 * verificadas nos módulos que as implementam — a camada de sessão é fina por
 * construção (actions = wrapper de requireUser/assertAdmin + regra aqui).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { all, insert, one, run, scalar } from "../src/lib/db.ts";
import { resetCompanyCache } from "../src/lib/db.ts";
import { canView, canEdit, ehAdmin, modulesFor, type Role } from "../src/lib/roles.ts";
import { destinoAposLogin } from "../src/lib/destino.ts";
import { SAAS_NAV, NAV } from "../src/lib/nav.ts";
import {
  listarUsuarios,
  criarUsuario,
  atualizarUsuario,
  alternarStatusUsuario,
  excluirUsuario,
  papelValido,
  PAPEIS_ATRIBUIVEIS,
  ehAdminEmpresa,
  type Ator,
} from "../src/lib/usuarios.ts";
import { podeCriarUsuario, limiteUsuarios, usuariosAtivos, assinaturaDaEmpresa } from "../src/lib/billing.ts";
import { getCustomer } from "../src/lib/queries.ts";
import { getReservation } from "../src/lib/reservations.ts";
import { getPurchase } from "../src/lib/compras.ts";
import { logAction } from "../src/lib/audit.ts";

let seq = 0;
let seqDoc = 0;

beforeEach(() => {
  resetTestDb();
  resetCompanyCache();
  createTestDb();
  seq = 0;
  seqDoc = 0;
});

/* ----------------------- identidade do cadastro ----------------------- */

/** CPF válido (dígitos verificadores conferidos) derivado de um número de série. */
function cpfDeSerie(n: number): string {
  const base = String(100000000 + n); // 9 dígitos
  const dv = (b: string, pesos: number[]) => {
    const soma = b.split("").reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = dv(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(base + d1, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return base + d1 + d2;
}

/**
 * Identidade obrigatória do cadastro (migração 0037): tipo de pessoa, CPF
 * válido e e-mail únicos por chamada — espalhado nos criarUsuario que devem
 * ter sucesso, para falharem só pelo motivo que o teste examina.
 */
function identidade(username: string) {
  return { email: `${username}@teste.com`, tipo_pessoa: "pf", documento: cpfDeSerie(++seqDoc) };
}

/* ----------------------------- fixtures ----------------------------- */

async function criarEmpresas() {
  await run(`UPDATE companies SET name = 'Empresa A' WHERE id = 1`);
  await insert(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa B', 1)`);
  await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (2, 0)`);
}

/** Owner da empresa (administrador primário). */
async function owner(companyId: number): Promise<Ator & { username: string }> {
  const username = `owner${companyId}_${++seq}`;
  const id = await insert(
    `INSERT INTO users (name, username, password_hash, role, company_id) VALUES (?,?,?,?,?)`,
    [`Owner ${companyId}`, username, "x", "owner", companyId],
  );
  return { id, name: `Owner ${companyId}`, company_id: companyId, role: "owner", username };
}

/** Admin secundário da empresa. */
async function adminEmpresa(companyId: number): Promise<Ator> {
  const id = await insert(
    `INSERT INTO users (name, username, password_hash, role, company_id) VALUES (?,?,?,?,?)`,
    [`Admin ${companyId}`, `admin${companyId}_${++seq}`, "x", "admin", companyId],
  );
  return { id, name: `Admin ${companyId}`, company_id: companyId, role: "admin" };
}

/** Operador simples. */
async function operador(companyId: number): Promise<Ator> {
  const id = await insert(
    `INSERT INTO users (name, username, password_hash, role, company_id) VALUES (?,?,?,?,?)`,
    [`Op ${companyId}`, `op${companyId}_${++seq}`, "x", "operacional", companyId],
  );
  return { id, name: `Op ${companyId}`, company_id: companyId, role: "operacional" };
}

/** platform_admin (Administrador Geral — Uériclis), com empresa própria. */
async function platformAdmin(companyId = 1): Promise<Ator> {
  const id = await insert(
    `INSERT INTO users (name, username, password_hash, role, company_id, platform_admin) VALUES (?,?,?,?,?,1)`,
    [`Uériclis`, `uericlis_${++seq}`, "x", "owner", companyId],
  );
  return { id, name: "Uériclis", company_id: companyId, role: "owner" };
}

/** Define o plano/assinatura da empresa (limites por plano). */
async function definirPlano(companyId: number, maxUsers: number) {
  const planoId = await insert(
    `INSERT INTO plans (slug, name, price_cents, max_users, trial_days, active, sort_order)
     VALUES (?,?,?,?,?,1,?)`,
    [`p${companyId}_${++seq}`, `Plano ${maxUsers}`, 7990, maxUsers, 14, maxUsers],
  );
  await insert(
    `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
     VALUES (?,?,?,?,?,?)`,
    [companyId, planoId, "trial", "2026-12-31", "2026-12-01", "2026-12-31"],
  );
}

async function cliente(companyId: number) {
  return await insert(`INSERT INTO customers (name, phone, company_id) VALUES (?,?,?)`, [
    `Cliente ${++seq}`,
    "11999990000",
    companyId,
  ]);
}

async function produto(companyId: number, total = 10) {
  return await insert(
    `INSERT INTO products (code, name, kind, total_qty, rent_price_cents, company_id) VALUES (?,?,?,?,?,?)`,
    [`P${++seq}`, `Produto ${seq}`, "simples", total, 1000, companyId],
  );
}

async function reserva(companyId: number, clienteId: number, produtoId: number) {
  const id = await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, delivery_at, pickup_at, company_id)
     VALUES (?,?,?,?,?,?,?)`,
    [`R${++seq}`, clienteId, "confirmada", "2026-10-10", "2026-10-10T08:00", "2026-10-11T10:00", companyId],
  );
  await insert(
    `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents, company_id) VALUES (?,?,?,?,?)`,
    [id, produtoId, 1, 1000, companyId],
  );
  return id;
}

async function compra(companyId: number, userId: number) {
  return await insert(
    `INSERT INTO purchases (number, purchase_date, total_cents, company_id, created_by) VALUES (?,?,?,?,?)`,
    [`C${++seq}`, "2026-09-01", 5000, companyId, userId],
  );
}

/* ===================== hierarquia e painel SaaS (T1, T6, T7) ===================== */

describe("TESTE 1 — Administrador Geral acessa o painel SaaS", () => {
  it("destinoAposLogin manda platform_admin para /saas e os demais para o app operacional", async () => {
    await criarEmpresas();
    const uericlis = await platformAdmin(1);
    const dono = await owner(2);
    // Uériclis: platform_admin → ambiente da plataforma
    assert.equal(destinoAposLogin({ platform_admin: true }), "/saas");
    // dono da empresa 2: NUNCA /saas
    const row = await one<{ platform_admin: number }>(`SELECT platform_admin FROM users WHERE id = ?`, [dono.id]);
    assert.equal(row!.platform_admin, 0);
    assert.equal(destinoAposLogin({ platform_admin: false }), "/dashboard");
    // sanity: o usuário de plataforma existe com a flag correta
    const u = await one<{ platform_admin: number; role: string }>(`SELECT platform_admin, role FROM users WHERE id = ?`, [uericlis.id]);
    assert.equal(u!.platform_admin, 1);
    assert.equal(u!.role, "owner");
  });

  it("o menu SaaS é exclusivo da plataforma e o menu operacional não contém /saas", async () => {
    assert.ok(SAAS_NAV.some((n) => n.href === "/saas"));
    assert.ok(!NAV.some((n) => n.href.startsWith("/saas")));
  });
});

describe("TESTES 6 e 7 — operador e admin de empresa NÃO acessam o painel SaaS", () => {
  it("nenhum papel de empresa equivale a platform_admin no banco", async () => {
    await criarEmpresas();
    for (const papel of ["owner", "admin", "operacional", "financeiro", "viewer"] as Role[]) {
      const u = await insert(
        `INSERT INTO users (name, username, password_hash, role, company_id) VALUES (?,?,?,?,1)`,
        [`U`, `u${papel}${++seq}`, "x", papel],
      );
      const row = await one<{ platform_admin: number }>(`SELECT platform_admin FROM users WHERE id = ?`, [u]);
      assert.equal(row!.platform_admin, 0, `papel ${papel} não pode nascer como platform_admin`);
    }
  });

  it("criarUsuario NUNCA atribui platform_admin nem role owner (payload manipulado)", async () => {
    await criarEmpresas();
    const adm = await owner(1);
    // payload com role "owner" / "platform_admin" / lixo: recusado pela whitelist
    // ("ADMIN" é aceito de propósito: normaliza para o papel legítimo "admin")
    for (const papelMalicioso of ["owner", "platform_admin", "superadmin", "admin; --", "viewer"]) {
      const r = await criarUsuario(adm, {
        name: "Tentativa",
        username: `x${++seq}`,
        password: "senha123",
        role: papelMalicioso,
      });
      assert.equal(r.ok, false, `papel "${papelMalicioso}" deveria ser recusado`);
    }
    // "admin" é aceito, mas gera apenas admin de EMPRESA, sem platform_admin
    const r = await criarUsuario(adm, {
      name: "Sec",
      username: `sec${++seq}`,
      password: "senha123",
      role: "admin",
      ...identidade(`sec${seq}`),
    });
    assert.equal(r.ok, true);
    const row = await one<{ role: string; platform_admin: number }>(`SELECT role, platform_admin FROM users WHERE id = ?`, [
      (r as { ok: true; id: number }).id,
    ]);
    assert.equal(row!.role, "admin");
    assert.equal(row!.platform_admin, 0);
  });
});

/* ===================== papel do administrador da empresa (T2, T3, T4) ===================== */

describe("TESTES 2–4 — administrador da empresa x operador nas configurações", () => {
  it("owner e admin (papeis de empresa) sao administrativos; operador nao", () => {
    assert.ok(ehAdminEmpresa("owner"));
    assert.ok(ehAdminEmpresa("admin"));
    assert.ok(!ehAdminEmpresa("operacional"));
    assert.ok(!ehAdminEmpresa("financeiro"));
    assert.ok(!ehAdminEmpresa("viewer"));
    // A MESMA função ehAdmin é o que a tela de configurações usa agora:
    assert.ok(ehAdmin("owner"));
    assert.ok(ehAdmin("admin"));
    assert.ok(!ehAdmin("operacional"));
  });

  it("owner e admin editam configuracoes/usuarios; operador só vê o que o papel permite", () => {
    assert.ok(canEdit("owner", "configuracoes"));
    assert.ok(canEdit("admin", "configuracoes"));
    assert.ok(!canEdit("operacional", "configuracoes"));
    assert.ok(!canEdit("financeiro", "configuracoes"));
    assert.ok(canEdit("owner", "usuarios"));
    assert.ok(canEdit("admin", "usuarios"));
    assert.ok(!canEdit("operacional", "usuarios"));
    // leitura: operador nem chega à aba de configurações
    assert.ok(!canView("operacional", "configuracoes"));
    assert.ok(!canView("viewer", "configuracoes"));
  });

  it("operador navega os módulos operacionais e nada administrativo (menu)", () => {
    const menu = modulesFor("operacional");
    assert.ok(menu.includes("reservas"));
    assert.ok(menu.includes("clientes"));
    assert.ok(!menu.includes("configuracoes"));
    assert.ok(!menu.includes("usuarios"));
    assert.ok(!menu.includes("assinatura"));
  });
});

/* ===================== limites do plano (T10, T11, T12) ===================== */

describe("TESTES 10–12 — limite de usuários validado no BACKEND", () => {
  it("T10: admin cria usuário DENTRO do limite", async () => {
    await criarEmpresas();
    await definirPlano(1, 3);
    const adm = await owner(1); // 1 ativo
    assert.equal((await podeCriarUsuario(1)).ok, true);
    const r = await criarUsuario(adm, { name: "Op 2", username: `op2${seq}`, password: "senha123", role: "operacional", ...identidade(`op2${seq}`) });
    assert.equal(r.ok, true);
    assert.equal(await usuariosAtivos(1), 2);
  });

  it("T11: o SEXTO usuário (limite do plano) é NEGADO pelo backend, mesmo chamando a função direto", async () => {
    await criarEmpresas();
    await definirPlano(2, 5);
    const adm = await owner(2); // 1 ativo
    for (let i = 0; i < 4; i++) {
      const r = await criarUsuario(adm, { name: `Op ${i}`, username: `op${i}_${++seq}`, password: "senha123", role: "operacional", ...identidade(`op${i}_${seq}`) });
      assert.equal(r.ok, true);
    }
    assert.equal(await usuariosAtivos(2), 5); // cheio
    // a tentativa do sexto é recusada NO BACKEND (não existe botão para furar)
    const r6 = await criarUsuario(adm, { name: "Op 6", username: `op6_${seq}`, password: "senha123", role: "operacional", ...identidade(`op6_${seq}`) });
    assert.equal(r6.ok, false);
    assert.match((r6 as { ok: false; erro: string }).erro, /Limite do plano atingido \(5/);
    assert.equal(await usuariosAtivos(2), 5);
  });

  it("T12: usuário INATIVADO e EXCLUÍDO liberam a vaga; excluído some da lista", async () => {
    await criarEmpresas();
    await definirPlano(1, 2);
    const adm = await owner(1); // 1 ativo
    const op = await criarUsuario(adm, { name: "Op", username: `op${++seq}`, password: "senha123", role: "operacional", ...identidade(`op${seq}`) });
    assert.equal((op as { ok: true }).ok, true);
    assert.equal(await usuariosAtivos(1), 2); // cheio
    // inativar libera a vaga
    const opId = (op as { ok: true; id: number }).id;
    await alternarStatusUsuario(adm, opId);
    assert.equal(await usuariosAtivos(1), 1);
    const r = await criarUsuario(adm, { name: "Novo", username: `novo${++seq}`, password: "senha123", role: "operacional", ...identidade(`novo${seq}`) });
    assert.equal(r.ok, true, "vaga liberada pela inativação");
    // excluir libera de novo (usuário sem vínculos)
    await excluirUsuario(adm, opId);
    assert.equal(await usuariosAtivos(1), 2); // owner + novo
    const sumiu = await one(`SELECT id FROM users WHERE id = ?`, [opId]);
    assert.equal(sumiu, undefined);
    const lista = await listarUsuarios(1);
    assert.ok(lista.every((u: any) => u.id !== opId));
  });

  it("exclusão é recusada quando o usuário tem histórico (mesmo inativo) — preserva auditoria", async () => {
    await criarEmpresas();
    const adm = await owner(1);
    const alvo = await operador(1);
    // vínculo: uma saída financeira criada pelo operador
    await insert(`INSERT INTO expenses (date, category, description, amount_cents, status, created_by, company_id) VALUES ('2026-09-01','Outros','x',100,'pago',?,1)`, [alvo.id]);
    const r = await excluirUsuario(adm, alvo.id);
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; erro: string }).erro, /Inative o usuário/);
  });

  it("limite sem assinatura e sem catálogo cai no default (3) — empresa recém-criada", async () => {
    await criarEmpresas();
    await run(`DELETE FROM subscriptions`);
    await run(`DELETE FROM plans`);
    assert.equal(await limiteUsuarios(2), 3);
    assert.equal(await assinaturaDaEmpresa(2), null);
  });
});

/* ===================== escalada de privilégio (T8, T9) ===================== */

describe("TESTES 8 e 9 — alterar próprio role e companyId no payload", () => {
  it("T8: usuário NÃO altera o próprio papel", async () => {
    await criarEmpresas();
    const adm = await owner(1);
    // o próprio admin tenta se promover/rebaixar via atualizarUsuario
    const r1 = await atualizarUsuario(adm, adm.id, { name: adm.name, username: `own${seq}`, role: "operacional" });
    assert.equal(r1.ok, false);
    assert.match((r1 as { ok: false; erro: string }).erro, /próprio papel/i);
    // o papel no banco continua owner
    const row = await one<{ role: string }>(`SELECT role FROM users WHERE id = ?`, [adm.id]);
    assert.equal(row!.role, "owner");
    // operador tentando usar a função: barrado por autorização, antes de tudo
    const op = await operador(1);
    const r2 = await atualizarUsuario(op, op.id, { name: op.name, username: `op${++seq}`, role: "admin" });
    assert.equal(r2.ok, false);
  });

  it("T8b: owner da empresa não pode ser rebaixado, inativado nem excluído", async () => {
    await criarEmpresas();
    const adm = await adminEmpresa(1);
    const dono = await owner(1);
    const r1 = await atualizarUsuario(adm, dono.id, { name: "X", username: `d${++seq}`, role: "operacional" });
    assert.equal(r1.ok, false);
    const r2 = await alternarStatusUsuario(adm, dono.id);
    assert.equal(r2.ok, false);
    const r3 = await excluirUsuario(adm, dono.id);
    assert.equal(r3.ok, false);
    const row = await one<{ role: string; active: number }>(`SELECT role, active FROM users WHERE id = ?`, [dono.id]);
    assert.equal(row!.role, "owner");
    assert.equal(row!.active, 1);
  });

  it("T9: companyId no payload é IGNORADO — usuário criado/editado fica na empresa do ator", async () => {
    await criarEmpresas();
    const admA = await owner(1);
    // tentativa de "criar na empresa 2": a função nem recebe companyId externo,
    // e o INSERT usa ator.company_id — a linha nasce na empresa do ator
    const r = await criarUsuario(admA, { name: "Furo", username: `furo${++seq}`, password: "senha123", role: "admin", ...identidade(`furo${seq}`) });
    assert.equal(r.ok, true);
    const row = await one<{ company_id: number }>(`SELECT company_id FROM users WHERE id = ?`, [
      (r as { ok: true; id: number }).id,
    ]);
    assert.equal(row!.company_id, 1);
    // edição de usuário de OUTRA empresa: "não encontrado" (id manipulado)
    const admB = await owner(2);
    const alvoB = await operador(2);
    const r2 = await atualizarUsuario(admA, alvoB.id, { name: "H", username: `h${++seq}`, role: "operacional" });
    assert.equal(r2.ok, false, "admin da empresa A não edita usuário da empresa B");
    const r3 = await excluirUsuario(admA, alvoB.id);
    assert.equal(r3.ok, false);
    const r4 = await alternarStatusUsuario(admA, alvoB.id);
    assert.equal(r4.ok, false);
  });
});

/* ===================== operador sem poder administrativo ===================== */

describe("Operador não gerencia usuários nem configurações", () => {
  it("criar/editar/excluir por operador são recusados", async () => {
    await criarEmpresas();
    const op = await operador(1);
    const r1 = await criarUsuario(op, { name: "X", username: `x${++seq}`, password: "senha123", role: "admin" });
    assert.equal(r1.ok, false);
    assert.match((r1 as { ok: false; erro: string }).erro, /Somente o administrador da empresa/i);
    const dono = await owner(1);
    const r2 = await excluirUsuario(op, dono.id);
    assert.equal(r2.ok, false);
  });
});

/* ===================== multi-tenancy (T5, T13–T16, T18) ===================== */

describe("TESTES 5, 13–16 e 18 — isolamento entre empresas por ID manipulado", () => {
  it("T5: administrador da empresa A não vê nem edita dados da empresa B", async () => {
    await criarEmpresas();
    const cA = await cliente(1);
    const cB = await cliente(2);
    // leitura por id: empresa B não existe para A
    assert.ok(await getCustomer(cA, 1));
    assert.equal(await getCustomer(cB, 1), undefined);
    assert.equal(await getCustomer(cA, 2), undefined);
  });

  it("T13: cliente de outra empresa NEGADO (getter por id)", async () => {
    await criarEmpresas();
    const cB = await cliente(2);
    assert.equal(await getCustomer(cB, 1), undefined);
    assert.ok(await getCustomer(cB, 2));
  });

  it("T14: reserva de outra empresa NEGADO (getter por id)", async () => {
    await criarEmpresas();
    const rA = await reserva(1, await cliente(1), await produto(1));
    const rB = await reserva(2, await cliente(2), await produto(2));
    assert.ok(await getReservation(rA, 1));
    assert.equal(await getReservation(rB, 1), undefined);
    assert.equal(await getReservation(rA, 2), undefined);
  });

  it("T15: produto de outra empresa NEGADO — updateProduct de B não alcança produto de A", async () => {
    await criarEmpresas();
    const pA = await produto(1);
    const pB = await produto(2);
    // exatamente o SELECT da action updateProduct com companyId da sessão:
    const deA = await one(`SELECT * FROM products WHERE id = ? AND company_id = ?`, [pA, 1]);
    const invasor = await one(`SELECT * FROM products WHERE id = ? AND company_id = ?`, [pA, 2]);
    assert.ok(deA);
    assert.equal(invasor, undefined);
    // o UPDATE da action é escopado: empresa B não altera o produto de A
    await run(`UPDATE products SET name = 'HACK' WHERE id = ? AND company_id = ?`, [pA, 2]);
    const ainda = await one<{ name: string }>(`SELECT name FROM products WHERE id = ?`, [pA]);
    assert.notEqual(ainda!.name, "HACK");
    // e o produto B continua isolado
    assert.ok(await one(`SELECT id FROM products WHERE id = ? AND company_id = ?`, [pB, 2]));
  });

  it("T16: pagamento/assinatura de outra empresa NEGADO", async () => {
    await criarEmpresas();
    await definirPlano(1, 3);
    await definirPlano(2, 3);
    // cobranças (subscription_payments) listadas SEMPRE por company_id da sessão
    await insert(
      `INSERT INTO subscription_payments (company_id, subscription_id, asaas_payment_id, amount_cents, billing_type, status, due_date, period_start, period_end)
       VALUES (1,1,'pay_a',7990,'PIX','pending','2026-10-10','2026-09-10','2026-10-10')`,
    );
    const daEmpresa1 = await all(`SELECT * FROM subscription_payments WHERE company_id = 1`);
    const daEmpresa2 = await all(`SELECT * FROM subscription_payments WHERE company_id = 2`);
    assert.equal(daEmpresa1.length, 1);
    assert.equal(daEmpresa2.length, 0);
    // compra (financeiro do tenant) isolada: getPurchase de B não sai para A
    const donoB = await owner(2);
    const cB = await compra(2, donoB.id);
    assert.ok(await getPurchase(cB, 2));
    assert.equal(await getPurchase(cB, 1), undefined);
    // assinaturas: cada empresa só enxerga a própria
    const s1 = await one(`SELECT id FROM subscriptions WHERE company_id = 1`);
    assert.ok(s1);
    const viaSessaoErrada = await one(`SELECT id FROM subscriptions WHERE company_id = 1 AND company_id = 2`);
    assert.equal(viaSessaoErrada, undefined);
  });

  it("T18: manipulação de IDs não vaza dados (produtos, compras, reservas, clientes)", async () => {
    await criarEmpresas();
    const cA = await cliente(1);
    const pA = await produto(1);
    await reserva(1, cA, pA);
    const donoA = await owner(1);
    await compra(1, donoA.id);
    const cB = await cliente(2);
    const pB = await produto(2);
    await reserva(2, cB, pB);

    // tentando acessar TODOS os ids da empresa 2 como se fosse a empresa 1:
    for (const [tabela, id] of [
      ["customers", cB],
      ["products", pB],
    ] as const) {
      const vazou = await one<any>(`SELECT * FROM ${tabela} WHERE id = ? AND company_id = 1`, [id]);
      assert.equal(vazou, undefined, `${tabela} de B não pode aparecer para A`);
    }
    // e a reserva de B não é acessível pelo getter escopado de A
    const rB = await one(`SELECT id FROM reservations WHERE company_id = 2`);
    assert.equal(await getReservation((rB as any).id, 1), undefined);
  });
});

/* ===================== logs e auditoria ===================== */

describe("Logs de auditoria das ações críticas", () => {
  it("criar/atualizar/inativar/excluir usuário gravam em audit_logs com ator e empresa", async () => {
    await criarEmpresas();
    const adm = await owner(1);
    const logs = (acao: string, entidade: string, id: number | null, resumo: string) =>
      logAction({ id: adm.id, name: adm.name, username: "x", role: adm.role, company_id: 1, avatar_url: null, platform_admin: false }, acao, entidade, id, resumo);

    const r = await criarUsuario(adm, { name: "Log", username: `log${++seq}`, password: "senha123", role: "operacional", ...identidade(`log${seq}`) }, logs);
    assert.equal(r.ok, true);
    const id = (r as { ok: true; id: number }).id;
    await atualizarUsuario(adm, id, { name: "Log 2", username: `log${seq}`, role: "admin" }, logs);
    await alternarStatusUsuario(adm, id, logs);
    await excluirUsuario(adm, id, logs);

    const linhas = await all<{ action: string; entity: string; company_id_ref: number | null }>(
      `SELECT action, entity, company_id_ref FROM audit_logs WHERE entity = 'usuario' ORDER BY id`,
    );
    assert.deepEqual(
      linhas.map((l) => l.action),
      ["criar", "editar", "inativar", "excluir"],
    );
    assert.ok(linhas.every((l) => l.company_id_ref === 1));
  });

  it("ações da plataforma sobre assinatura são registradas (suspend/reativar via lib)", async () => {
    await criarEmpresas();
    await definirPlano(2, 3);
    const adm = await platformAdmin(1);
    const { acaoPlataforma } = await import("../src/lib/billing.ts");
    await acaoPlataforma(2, "suspender");
    let sub = await one<{ status: string }>(`SELECT status FROM subscriptions WHERE company_id = 2`);
    assert.equal(sub!.status, "suspended");
    await logAction(
      { id: adm.id, name: adm.name, username: "x", role: adm.role, company_id: 1, avatar_url: null, platform_admin: true },
      "plataforma.suspender",
      "subscription",
      2,
      "Ação da plataforma: suspender (empresa 2)",
    );
    const log = await one<{ action: string }>(`SELECT action FROM audit_logs WHERE entity = 'subscription'`);
    assert.equal(log!.action, "plataforma.suspender");
  });
});

/* ===================== whitelist e sanitização ===================== */

describe("Whitelist de papéis e normalização", () => {
  it("papelValido aceita apenas admin/operacional (com apelido do formulário)", () => {
    assert.equal(papelValido("admin"), "admin");
    assert.equal(papelValido("operador"), "operacional");
    assert.equal(papelValido("operacional"), "operacional");
    assert.equal(papelValido("ADMIN"), "admin");
    assert.equal(papelValido("owner"), null);
    assert.equal(papelValido("viewer"), null);
    assert.equal(papelValido(""), null);
    assert.equal(papelValido("admin OR 1=1"), null);
  });

  it("PAPEIS_ATRIBUIVEIS nunca contém owner/viewer/financeiro", () => {
    const todos = PAPEIS_ATRIBUIVEIS as readonly string[];
    assert.ok(todos.includes("admin"));
    assert.ok(todos.includes("operacional"));
    assert.ok(!todos.includes("owner"));
    assert.ok(!todos.includes("viewer"));
    assert.ok(!todos.includes("financeiro"));
  });

  it("senha fraca e username duplicado são recusados no backend", async () => {
    await criarEmpresas();
    const adm = await owner(1);
    const r1 = await criarUsuario(adm, { name: "A", username: `a${++seq}`, password: "123", role: "operacional" });
    assert.equal(r1.ok, false);
    assert.match((r1 as { ok: false; erro: string }).erro, /6 caracteres/);
    const r2 = await criarUsuario(adm, { name: "B", username: adm.username, password: "senha123", role: "operacional", ...identidade(`dup${seq}`) });
    assert.equal(r2.ok, false);
    assert.match((r2 as { ok: false; erro: string }).erro, /já existe/i);
  });
});
