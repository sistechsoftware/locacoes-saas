/**
 * Configurações → Navegação (portação da Lima's Locações para o SaaS).
 *
 * O sistema ganha um segundo modo de menu — "agrupado" — escolhido pelo
 * administrador na aba Navegação e persistido em company_settings
 * (chave nav_layout, padrão "classico"). Cobre:
 *  - grupos cobrem EXATAMENTE os destinos do NAV (nada some, nada duplica);
 *  - o resolver normaliza qualquer lixo para "classico" (empresas existentes
 *    continuam vendo o menu de hoje);
 *  - o filtro de plano e as personalizações administrativas continuam valendo
 *    dentro dos grupos (mesma precedência do modo clássico);
 *  - persistência da chave por empresa e isolamento entre empresas;
 *  - atualização de nav_layout preserva as demais configurações da empresa;
 *  - leitura com valor inválido no banco não quebra e cai no clássico.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ACOES_AGRUPADO,
  ACOES_SHEET_AGRUPADO,
  EXTRA_NAV,
  MOBILE_NAV,
  NAV,
  NAV_GRUPOS,
  gruposParaPlano,
  resolverNavLayout,
} from "../src/lib/nav.ts";
import { getSettings, setSettings, DEFAULT_SETTINGS, isKnownSetting } from "../src/lib/settings.ts";
import { one, run } from "../src/lib/db.ts";
import { createTestDb } from "./helpers/d1.ts";

/* --------------------------- estrutura dos grupos --------------------------- */

describe("modo agrupado — estrutura", () => {
  it("NAV_GRUPOS cobre exatamente os mesmos destinos do NAV, sem sobra e sem falta", () => {
    const doMenu = NAV.map((n) => n.href).sort();
    const dosGrupos = NAV_GRUPOS.flatMap((g) => g.itens.map((n) => n.href)).sort();
    assert.deepEqual(dosGrupos, doMenu, "cada href do NAV deve aparecer exatamente uma vez nos grupos");
  });

  it("itens dos grupos repetem label e icon do NAV (mesma destinação, só muda a apresentação)", () => {
    const porHref = new Map(NAV.map((n) => [n.href, n]));
    for (const g of NAV_GRUPOS) {
      for (const n of g.itens) {
        const original = porHref.get(n.href);
        assert.ok(original, `${n.href} não existe no NAV`);
        assert.equal(n.label, original.label, `label divergente em ${n.href}`);
        assert.equal(n.icon, original.icon, `icon divergente em ${n.href}`);
        assert.equal(n.adminOnly, original.adminOnly, `adminOnly divergente em ${n.href}`);
      }
    }
  });

  it("nenhum grupo nasce vazio", () => {
    for (const g of NAV_GRUPOS) assert.ok(g.itens.length > 0, `${g.titulo} vazio`);
  });
});

/* ----------------------------- normalização ----------------------------- */

describe("resolverNavLayout — regra única de normalização", () => {
  it("somente 'agrupado' liga o modo agrupado", () => {
    assert.equal(resolverNavLayout("agrupado"), "agrupado");
  });

  it("qualquer outro valor cai no clássico (padrão das empresas existentes)", () => {
    for (const valor of ["classico", "", "banana", null, undefined, 0, "AGRUPADO"]) {
      assert.equal(resolverNavLayout(valor), "classico", `valor ${String(valor)} deve cair no classico`);
    }
  });
});

/* --------------------- filtros de plano dentro dos grupos --------------------- */

describe("modo agrupado — plano e personalizações continuam valendo", () => {
  it("essencial: itens pagos fora do plano saem dos grupos e grupos vazios não sobram", () => {
    const grupos = gruposParaPlano(NAV_GRUPOS, "essencial", null);
    const hrefs = grupos.flatMap((g) => g.itens.map((n) => n.href));
    for (const pago of ["/chat", "/fidelidade", "/relatorios", "/fretes", "/contratos"]) {
      assert.equal(hrefs.includes(pago), false, `${pago} não pode aparecer para essencial`);
    }
    // fundamentais continuam de pé e nenhum grupo fantasia aparece
    for (const fundamental of ["/dashboard", "/agenda", "/reservas", "/operacao", "/clientes", "/estoque", "/financeiro", "/configuracoes"]) {
      assert.equal(hrefs.includes(fundamental), true, `${fundamental} é fundamental`);
    }
    for (const g of grupos) assert.ok(g.itens.length > 0, `${g.titulo} não pode sobrar vazio`);
  });

  it("operador da plataforma (plano undefined) não tem restrição — todos os destinos", () => {
    const hrefs = gruposParaPlano(NAV_GRUPOS, undefined, null).flatMap((g) => g.itens.map((n) => n.href));
    assert.deepEqual([...hrefs].sort(), NAV.map((n) => n.href).sort());
  });

  it("personalização administrativa (liberação) vale dentro dos grupos", () => {
    const grupos = gruposParaPlano(NAV_GRUPOS, "essencial", { extras: ["chat"], bloqueados: [] });
    const hrefs = grupos.flatMap((g) => g.itens.map((n) => n.href));
    assert.equal(hrefs.includes("/chat"), true, "liberação administrativa deve valer no modo agrupado");
  });

  it("personalização administrativa (bloqueio) também vale dentro dos grupos", () => {
    const grupos = gruposParaPlano(NAV_GRUPOS, "empresarial", { extras: [], bloqueados: ["relatorios"] });
    const hrefs = grupos.flatMap((g) => g.itens.map((n) => n.href));
    assert.equal(hrefs.includes("/relatorios"), false, "bloqueio administrativo deve valer no modo agrupado");
  });

  it("rótulo da operação (tituloOperacoes) é aplicado dentro dos grupos", () => {
    const grupos = gruposParaPlano(NAV_GRUPOS, undefined, null, "Devoluções");
    const op = grupos.flatMap((g) => g.itens).find((n) => n.href === "/operacao");
    assert.equal(op?.label, "Devoluções");
    const agenda = grupos.flatMap((g) => g.itens).find((n) => n.href === "/agenda");
    assert.equal(agenda?.label, "Agenda", "demais rótulos intactos");
  });
});

/* ------------------------- ações rápidas do + e do sheet ------------------------- */

describe("ações rápidas do modo agrupado", () => {
  it("ACOES_AGRUPADO remove somente o atalho Mensagens", () => {
    const acoes = ACOES_AGRUPADO([
      { href: "/chat", label: "Mensagens", icon: "chat" },
      { href: "/reservas/nova", label: "Nova Reserva", icon: "reservas" },
      { href: "/clientes/novo", label: "Novo Cliente", icon: "clientes" },
    ]);
    assert.deepEqual(acoes.map((a) => a.href), ["/reservas/nova", "/clientes/novo"]);
  });

  it("ACOES_SHEET_AGRUPADO são criações, nenhuma na barra inferior e sem Mensagens", () => {
    const hrefs = ACOES_SHEET_AGRUPADO.map((a) => a.href);
    assert.equal(new Set(hrefs).size, hrefs.length, "atalhos duplicados");
    assert.equal(hrefs.includes("/chat"), false);
    for (const a of ACOES_SHEET_AGRUPADO) {
      assert.equal(MOBILE_NAV.some((m) => m.href === a.href), false, `${a.href} não pode repetir a barra`);
      assert.equal(EXTRA_NAV.some((m) => m.href === a.href), false, `${a.href} é criação, não listagem`);
    }
  });
});

/* --------------------- persistência e isolamento por empresa --------------------- */

function cenario() {
  createTestDb();
}

describe("nav_layout em company_settings", () => {
  beforeEach(cenario);

  it("a whitelist conhece nav_layout e o padrão é o clássico", () => {
    assert.ok(isKnownSetting("nav_layout"), "chave precisa ser aceita pela whitelist de setSettings");
    assert.equal(DEFAULT_SETTINGS.nav_layout, "classico");
  });

  it("empresa sem nenhuma linha nav_layout continua no clássico (compatibilidade)", async () => {
    assert.equal((await getSettings()).nav_layout, "classico");
  });

  it("o que o administrador salva volta na leitura seguinte (persistência)", async () => {
    await setSettings({ nav_layout: "agrupado" });
    assert.equal((await getSettings()).nav_layout, "agrupado");
    const linha = await one(`SELECT value FROM company_settings WHERE company_id = 1 AND key = 'nav_layout'`);
    assert.equal(linha?.value, "agrupado");
  });

  it("atualizar nav_layout preserva as demais configurações da empresa", async () => {
    await setSettings({ company_name: "Locadora Centro", pix_key: "pix@exemplo.com" });
    await setSettings({ nav_layout: "agrupado" });
    const s = await getSettings();
    assert.equal(s.nav_layout, "agrupado");
    assert.equal(s.company_name, "Locadora Centro", "chaves não enviadas permanecem");
    assert.equal(s.pix_key, "pix@exemplo.com");
  });

  it("isolamento: o que uma empresa salva não aparece na outra", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Outra Empresa', 1)`);
    await setSettings({ nav_layout: "agrupado" }, 1);
    const { settingsDaEmpresa } = await import("../src/lib/settings.ts");
    assert.equal((await settingsDaEmpresa(1)).nav_layout, "agrupado");
    assert.equal((await settingsDaEmpresa(2)).nav_layout, "classico", "empresa 2 cai no padrão");
    const linhasDaDois = await one(
      `SELECT COUNT(*) AS n FROM company_settings WHERE company_id = 2 AND key = 'nav_layout'`,
    );
    assert.equal(linhasDaDois?.n, 0, "nenhuma linha nav_layout pode nascer na empresa errada");
  });

  it("as duas empresas podem ter layouts diferentes ao mesmo tempo", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Outra Empresa', 1)`);
    await setSettings({ nav_layout: "agrupado" }, 1);
    await setSettings({ nav_layout: "classico" }, 2);
    const { settingsDaEmpresa } = await import("../src/lib/settings.ts");
    assert.equal((await settingsDaEmpresa(1)).nav_layout, "agrupado");
    assert.equal((await settingsDaEmpresa(2)).nav_layout, "classico");
  });

  it("valor inválido gravado à mão no banco não quebra a leitura: o shell cai no clássico", async () => {
    await run(`INSERT INTO company_settings (company_id, key, value) VALUES (1, 'nav_layout', 'banana')`);
    const s = await getSettings();
    assert.equal(s.nav_layout, "banana", "getSettings devolve o valor cru");
    assert.equal(resolverNavLayout(s.nav_layout), "classico", "o shell normaliza para o clássico");
  });
});
