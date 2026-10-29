/**
 * Identidade visual POR EMPRESA (Configurações > Identidade visual).
 *
 * Trava o que não pode mudar sem ninguém perceber:
 *
 *  1. PADRÃO: empresa nova (sem linha em company_settings) nasce no tema
 *     original do Locô — compatibilidade com todos os tenants existentes;
 *  2. PERSISTÊNCIA E ISOLAMENTO: o que a empresa A escolhe sobrevive a um
 *     novo login/refresh e nunca vaza para a empresa B (mesmo company_settings
 *     multi-tenant dos demais ajustes, sem tabela nova);
 *  3. RESTAURAÇÃO: voltar ao Locô usa a fonte ÚNICA (src/lib/temas.ts) e os
 *     hexes batem com o @theme de globals.css — se o design original mudar,
 *     este teste acusa divergência;
 *  4. CONTRASTE: as 13 paletas cumprem WCAG 2.1 AA nos pares realmente
 *     usados pela interface (botão, link, menu ativo, FAB, texto, badge);
 *  5. PERMISSÃO E SEGURANÇA: a server action exige admin da própria empresa,
 *     só aceita IDs conhecidos e nunca lê tenant do formulário;
 *  6. ESCOPO: só o grupo (app) aplica o tema — /saas, login, portal e páginas
 *     públicas continuam com o tema do produto;
 *  7. SEMÂNTICOS INDEPENDENTES: erro/sucesso/alerta/informação e os neutros
 *     de texto não entram em nenhuma paleta;
 *  8. HIDRATAÇÃO: o override nasce no server component, sem localStorage e
 *     sem flash.
 */
import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ESCALAS,
  LISTA_TEMAS,
  PAPEIS_PERSONALIZAVEIS,
  TEMA_PADRAO,
  type PapelTema,
  TEMAS,
  contraste,
  cssDoTema,
  declaracoesDoTema,
  resolverTema,
  temaConhecido,
  variaveisDoTema,
} from "../src/lib/temas.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ler = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* ------------------------------------------------------------------ */
/* Scaffold do Next: a action importa next/* e lib/auth importa cookie. */
/* ------------------------------------------------------------------ */

const carregarOriginal = (Module as any)._load;
let sessaoAtual = "";

(Module as any)._load = function (request: string) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (nome: string) => (nome === "limas_session" && sessaoAtual ? { value: sessaoAtual } : undefined),
        set: () => {},
        delete: () => {},
      }),
      headers: async () => new Map(),
    };
  }
  if (request === "next/navigation") {
    return {
      redirect: (url: string) => {
        throw new Error("NEXT_REDIRECT:" + url);
      },
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
      useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request === "next/link" || request === "next/form" || request === "next/image") {
    return { __esModule: true, default: (p: any) => p?.children ?? null, Link: (p: any) => p?.children ?? null };
  }
  if (request === "server-only") return {};
  return carregarOriginal.apply(this, arguments as any);
};

/* ------------------------------------------------------------------ */
/* Estado do banco de teste                                            */
/* ------------------------------------------------------------------ */

let settings: typeof import("../src/lib/settings.ts");
let actions: typeof import("../src/app/(app)/configuracoes/actions.ts");
let db: typeof import("../src/lib/db.ts");
const FUTURO = new Date(Date.now() + 864e5).toISOString();

const SESSAO = { owner: "sess-tema-owner", admin: "sess-tema-admin", operacional: "sess-tema-operacional" };

before(async () => {
  const { createTestDb } = await import("./helpers/d1.ts");
  createTestDb();
  db = await import("../src/lib/db.ts");
  await db.run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active) VALUES
       (71, 'Dono A', 'tema-owner', 'x', 'owner', 1, 1),
       (72, 'Admin A', 'tema-admin', 'x', 'admin', 1, 1),
       (73, 'Operador A', 'tema-operacional', 'x', 'operacional', 1, 1)`,
  );
  await db.run(
    `INSERT INTO subscriptions (company_id, plan_id, status, current_period_end)
     VALUES (1, (SELECT id FROM plans WHERE slug = 'empresarial'), 'active', ?)`,
    [FUTURO.slice(0, 10)],
  );
  for (const [id, s] of [
    [71, SESSAO.owner],
    [72, SESSAO.admin],
    [73, SESSAO.operacional],
  ] as const) {
    await db.run(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`, [s, id, FUTURO]);
  }
  settings = await import("../src/lib/settings.ts");
  actions = await import(pathToFileURL(path.resolve(ROOT, "src/app/(app)/configuracoes/actions.ts")).href);
});

beforeEach(async () => {
  sessaoAtual = SESSAO.admin;
  await db.run(`DELETE FROM company_settings WHERE key = 'identidade_tema'`);
});
afterEach(() => {
  sessaoAtual = "";
});

function fd(pares: Record<string, string> = {}): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(pares)) f.set(k, v);
  return f;
}

async function erroDe(fn: () => Promise<unknown>): Promise<any | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e;
  }
}

const ehRedirect = (e: any, trecho: string) => String(e?.message ?? "").includes(trecho);

/* ================================================================== */
/* 1. Biblioteca de paletas                                            */
/* ================================================================== */

describe("biblioteca de paletas", () => {
  it("tem o padrão do Locô e 12 combinações distintas (13 no total)", () => {
    assert.equal(TEMA_PADRAO, "loco");
    assert.equal(LISTA_TEMAS.length, 13, "a grade precisa ofertar 13 paletas");
    assert.equal(LISTA_TEMAS[0].id, "loco", "o tema original vem primeiro");
    assert.equal(new Set(LISTA_TEMAS.map((t) => t.id)).size, 13, "ids duplicados");
    assert.equal(new Set(LISTA_TEMAS.map((t) => t.nome)).size, 13, "nomes duplicados");
  });

  it("a paleta Azul Royal reproduz o @theme do sistema antigo (fonte única daquele visual)", () => {
    const t = TEMAS["limas-locacoes"];
    assert.ok(t, "a opção do sistema antigo precisa existir na grade");
    assert.equal(t.nome, "Azul Royal");
    // os hexes colados do @theme de src/app/globals.css do Lima-s-Locacoes:
    assert.equal(t.cores.marca["600"], "#051094", "ação primária do sistema antigo");
    assert.equal(t.cores.marca["700"], "#040C75");
    assert.equal(t.cores.marca["300"], "#8E9BF0");
    assert.equal(t.cores.nuvem["100"], "#F5F7FF", "fundo frio do sistema antigo");
    assert.equal(t.cores.nuvem["300"], "#D7DEF2", "borda dos cartões");
    assert.equal(t.cores.tinta["900"], "#1A1816");
    assert.equal(t.cores.destaque["500"], "#F4B942", "o âmbar já era o mesmo");
    // único ponto em que a semântica do Locô obriga a desviar do CSS antigo:
    assert.ok(
      contraste(t.cores.marca["500"], t.cores.tinta["900"]) >= 4.5,
      "o ícone do botão flutuante precisa continuar legível nesta paleta",
    );
  });

  it("cada paleta declara os 23 degraus dos 4 papéis, em HEX válido", () => {
    const total = PAPEIS_PERSONALIZAVEIS.reduce((n, p) => n + ESCALAS[p].length, 0);
    assert.equal(total, 23, "a auditoria fechou em 23 variáveis de marca");
    for (const t of LISTA_TEMAS) {
      for (const papel of PAPEIS_PERSONALIZAVEIS) {
        for (const degrau of ESCALAS[papel]) {
          const cor = t.cores[papel][degrau];
          assert.ok(
            cor && /^#[0-9A-F]{6}$/.test(cor),
            `${t.id}.${papel}-${degrau} = ${String(cor)} não é #RRGGBB`,
          );
        }
      }
    }
  });

  it("o tema Locô é literalmente o @theme de globals.css (fonte única do original)", () => {
    const css = ler("src/app/globals.css");
    const bloco = css.match(/@theme\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    const declaradas: Record<string, string> = {};
    for (const m of bloco.matchAll(/--color-((?:marca|nuvem|tinta|destaque)-\d+):\s*(#[0-9A-Fa-f]{6})/g)) {
      declaradas[m[1]] = m[2].toUpperCase();
    }
    const doTema: Record<string, string> = {};
    for (const papel of PAPEIS_PERSONALIZAVEIS) {
      for (const degrau of ESCALAS[papel]) doTema[`${papel}-${degrau}`] = TEMAS.loco.cores[papel][degrau];
    }
    assert.deepEqual(doTema, declaradas, "restaurar o Locô precisa devolver o design original, não uma cópia");
  });

  it("todas as paletas cumprem WCAG 2.1 AA nos pares usados pela interface", () => {
    for (const t of LISTA_TEMAS) {
      const c = (p: PapelTema, d: string) => t.cores[p][d];
      const branco = "#FFFFFF";
      // [fundo, texto, mínimo, rótulo]
      const checagens: [string, string, number, string][] = [
        [branco, c("marca", "600"), 4.5, "branco no botão"],
        [branco, c("marca", "700"), 4.5, "branco no hover"],
        [c("nuvem", "100"), c("marca", "600"), 4.5, "link sobre o corpo"],
        [c("nuvem", "50"), c("marca", "600"), 4.5, "link sobre cartão"],
        [c("marca", "50"), c("marca", "600"), 4.5, "link fantasma"],
        [c("marca", "50"), c("marca", "700"), 4.5, "item ativo do menu inferior"],
        [c("marca", "100"), c("marca", "700"), 4.5, "item ativo do menu inferior"],
        [c("nuvem", "100"), c("tinta", "900"), 4.5, "texto principal"],
        [c("nuvem", "100"), c("tinta", "700"), 4.5, "menu lateral"],
        [c("nuvem", "100"), c("tinta", "800"), 4.5, "texto secundário"],
        [branco, c("tinta", "900"), 4.5, "texto no cartão"],
        [branco, c("tinta", "700"), 4.5, "texto secundário no cartão"],
        [c("marca", "500"), c("tinta", "900"), 4.5, "ícone do botão flutuante"],
        [c("destaque", "100"), c("destaque", "700"), 4.5, "badge de destaque"],
        [c("destaque", "500"), c("tinta", "900"), 4.5, "bloco de destaque"],
      ];
      for (const [fundo, texto, min, rotulo] of checagens) {
        const r = contraste(texto, fundo);
        assert.ok(
          r >= min,
          `${t.id}: ${rotulo} ${texto} sobre ${fundo} = ${r.toFixed(2)} (mínimo ${min})`,
        );
      }
      // não-textual: anel de foco e borda de controle pedem 3:1 (WCAG 1.4.11)
      assert.ok(
        contraste(c("marca", "600"), branco) >= 3,
        `${t.id}: anel de foco precisa de 3:1 sobre o branco`,
      );
      // o cartão precisa continuar separado do fundo da página
      assert.ok(
        contraste(c("nuvem", "100"), branco) >= 1.05,
        `${t.id}: fundo da página sem separação do cartão branco`,
      );
      assert.ok(
        contraste(c("nuvem", "300"), branco) >= 1.3,
        `${t.id}: borda do cartão invisível`,
      );
    }
  });

  it("nenhuma paleta é uma cópia quase idêntica de outra", () => {
    /* Distância perceptual em OKLab: mesmo L/croma com matiz trocado já conta
       como outra cor, e tons quase iguais (mesma cor "um passo diferente")
       caem abaixo do limiar. É a métrica que a auditoria pediu — não basta
       contar HEX diferentes. */
    const oklab = (hex: string) => {
      const [r, g, b] = [1, 3, 5]
        .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
      ];
    };
    const dist = (a: string, b: string) => {
      const [x, y, z] = oklab(a);
      const [u, v, w] = oklab(b);
      return Math.hypot(x - u, y - v, z - w);
    };
    /* A comparação é entre as DUAS cores de identidade (ação e acento): são
       elas que dizem "qual é este tema" na tela. Os neutros (nuvem/tinta)
       são sutilmente quentes ou frios por construção — medir eles diluiria a
       distância e aceitaria paletas que na prática são a mesma coisa. */
    const assinatura = (t: (typeof LISTA_TEMAS)[number]) => ({
      acao: t.cores.marca["600"],
      acento: t.cores.destaque["500"],
    });
    for (let i = 0; i < LISTA_TEMAS.length; i++) {
      for (let j = i + 1; j < LISTA_TEMAS.length; j++) {
        const a = assinatura(LISTA_TEMAS[i]);
        const b = assinatura(LISTA_TEMAS[j]);
        const dAcao = dist(a.acao, b.acao);
        const dAcento = dist(a.acento, b.acento);
        assert.ok(
          (dAcao + dAcento) / 2 >= 0.05,
          `${LISTA_TEMAS[i].id} e ${LISTA_TEMAS[j].id} são variações artificiais ` +
            `(ação ${dAcao.toFixed(3)} / acento ${dAcento.toFixed(3)})`,
        );
        // a cor de AÇÃO é a mais visível do produto: precisa separar sozinha
        assert.ok(
          dAcao >= 0.03,
          `${LISTA_TEMAS[i].id} e ${LISTA_TEMAS[j].id} têm ações praticamente iguais ` +
            `(${a.acao} / ${b.acao})`,
        );
      }
    }
  });
});

/* ================================================================== */
/* 2. Resolução segura                                                */
/* ================================================================== */

describe("resolverTema — entrada vinda do banco", () => {
  it("valor vazio/ausente cai no tema original do Locô", () => {
    for (const v of ["", "   ", null, undefined, 0]) {
      assert.equal(resolverTema(v).id, TEMA_PADRAO, `valor ${String(v)} deve cair no padrão`);
    }
  });

  it("lixo, tentativa de injeção ou id removido nunca aplica cor desconhecida", () => {
    for (const v of [
      "banana",
      "loco<script>",
      "{--color-marca-600:#000}",
      "AZUL-CORPORATIVO",
      "__proto__",
      "constructor",
      "#FF0000",
      'loco";background:red',
    ]) {
      assert.equal(resolverTema(v).id, TEMA_PADRAO, `"${v}" deve cair no padrão`);
      assert.equal(temaConhecido(v), false, `"${v}" não pode ser aceito pela action`);
    }
  });

  it("id real é reconhecido e resolve para a paleta inteira", () => {
    assert.equal(temaConhecido("azul-corporativo"), true);
    assert.equal(resolverTema(" azul-corporativo ").id, "azul-corporativo");
    assert.equal(Object.keys(resolverTema("roxo-sofisticado").cores).length, 4);
  });
});

/* ================================================================== */
/* 3. Persistência e isolamento entre empresas                        */
/* ================================================================== */

describe("identidade_tema em company_settings", () => {
  it("a whitelist conhece a chave e o padrão é vazio (tema original)", () => {
    assert.ok(
      settings.isKnownSetting("identidade_tema"),
      "a chave precisa ser aceita pela whitelist de setSettings",
    );
    assert.equal(settings.DEFAULT_SETTINGS.identidade_tema, "");
  });

  it("cenário 1: empresa sem nenhuma linha usa o tema original do Locô", async () => {
    const s = await settings.getSettings();
    assert.equal(s.identidade_tema, "", "empresa nova não pode ter tema gravado");
    assert.equal(resolverTema(s.identidade_tema).id, TEMA_PADRAO);
  });

  it("cenário 2: o que a empresa escolheu volta na leitura seguinte (novo login/refresh)", async () => {
    await settings.setSettings({ identidade_tema: "azul-corporativo" }, 1);
    // leitura nova, como faria um request posterior com outra sessão
    const s = await settings.settingsDaEmpresa(1);
    assert.equal(s.identidade_tema, "azul-corporativo");
    assert.equal(resolverTema(s.identidade_tema).id, "azul-corporativo");
    const linha = await db.one(
      `SELECT value FROM company_settings WHERE company_id = 1 AND key = 'identidade_tema'`,
    );
    assert.equal(linha?.value, "azul-corporativo", "a fonte é o banco, não o navegador");
  });

  it("cenário 3: a empresa B mantém a própria paleta, intocada pela A", async () => {
    await db.run(`INSERT INTO companies (id, name, active) VALUES (2, 'Outra Empresa', 1)`);
    await settings.setSettings({ identidade_tema: "verde-profissional" }, 1);
    await settings.setSettings({ identidade_tema: "roxo-sofisticado" }, 2);
    assert.equal(resolverTema((await settings.settingsDaEmpresa(1)).identidade_tema).id, "verde-profissional");
    assert.equal(resolverTema((await settings.settingsDaEmpresa(2)).identidade_tema).id, "roxo-sofisticado");
    const linhas = await db.scalar(
      `SELECT COUNT(*) FROM company_settings WHERE company_id = 2 AND key = 'identidade_tema'`,
    );
    assert.equal(linhas, 1, "uma única linha por empresa");
  });

  it("trocar o tema preserva as demais configurações da empresa", async () => {
    await settings.setSettings({ company_name: "Locadora Centro", pix_key: "pix@exemplo.com" }, 1);
    await settings.setSettings({ identidade_tema: "vinho-neutros" }, 1);
    const s = await settings.settingsDaEmpresa(1);
    assert.equal(s.identidade_tema, "vinho-neutros");
    assert.equal(s.company_name, "Locadora Centro", "chaves não enviadas permanecem");
    assert.equal(s.pix_key, "pix@exemplo.com");
  });

  it("valor inválido gravado à mão no banco não quebra a leitura", async () => {
    await db.run(
      `INSERT INTO company_settings (company_id, key, value) VALUES (1, 'identidade_tema', 'banana')`,
    );
    const s = await settings.getSettings();
    assert.equal(s.identidade_tema, "banana", "getSettings devolve o valor cru");
    assert.equal(resolverTema(s.identidade_tema).id, TEMA_PADRAO, "o layout normaliza para o padrão");
  });
});

/* ================================================================== */
/* 4. Server action: permissão, validação e escopo                    */
/* ================================================================== */

describe("saveIdentidadeVisual — permissão e validação", () => {
  it("cenário 6: usuário sem permissão não altera o tema", async () => {
    sessaoAtual = SESSAO.operacional;
    const e = await erroDe(() => actions.saveIdentidadeVisual(fd({ tema: "azul-corporativo" })));
    assert.equal(e?.name, "PermissionError", "operacional não pode trocar a identidade visual");
    const s = await settings.settingsDaEmpresa(1);
    assert.equal(s.identidade_tema, "", "nada pode ter sido gravado");
  });

  it("admin grava o tema escolhido na própria empresa", async () => {
    sessaoAtual = SESSAO.admin;
    await actions.saveIdentidadeVisual(fd({ tema: "cinza-azul" }));
    assert.equal((await settings.settingsDaEmpresa(1)).identidade_tema, "cinza-azul");
  });

  it("owner também pode (mesmo nível administrativo)", async () => {
    sessaoAtual = SESSAO.owner;
    await actions.saveIdentidadeVisual(fd({ tema: "grafite-ouro" }));
    assert.equal((await settings.settingsDaEmpresa(1)).identidade_tema, "grafite-ouro");
  });

  it("cenário 8: paleta inexistente é rejeitada com segurança, sem gravar", async () => {
    sessaoAtual = SESSAO.admin;
    const e = await erroDe(() => actions.saveIdentidadeVisual(fd({ tema: "cor-livre-#f00" })));
    assert.ok(ehRedirect(e, "aba=identidade"), `esperava redirect de erro, veio ${e?.message}`);
    assert.ok(ehRedirect(e, "erro="), "a tela precisa explicar o que houve");
    assert.equal((await settings.settingsDaEmpresa(1)).identidade_tema, "", "lixo nunca chega ao banco");
  });

  it("cenário 7: não existe caminho de escrever o tema de OUTRA empresa", async () => {
    sessaoAtual = SESSAO.admin;
    await db.run(`INSERT OR IGNORE INTO companies (id, name, active) VALUES (2, 'Outra Empresa', 1)`);
    // nem pelo formulário...
    await actions.saveIdentidadeVisual(fd({ tema: "azul-grafite", company_id: "2" }));
    assert.equal((await settings.settingsDaEmpresa(1)).identidade_tema, "azul-grafite");
    assert.equal(
      (await settings.settingsDaEmpresa(2)).identidade_tema,
      "",
      "a chave company_id do formulário é ignorada",
    );
    // ...nem por campo algum de identificação de tenant
    const corpo = ler("src/app/(app)/configuracoes/actions.ts").split("saveIdentidadeVisual")[1] ?? "";
    const bloco = corpo.slice(0, corpo.indexOf("\nexport async function"));
    assert.ok(!/company_id|companyId/i.test(bloco), "a action não pode ler tenant do request");
    assert.ok(!/req\.|request\.|headers\(/.test(bloco), "a action não pode ler da requisição cru");
  });

  it("restaurar é gravar o id do padrão (ação simples, nada mais é apagado)", async () => {
    sessaoAtual = SESSAO.admin;
    await settings.setSettings({ identidade_tema: "terracota-areia", company_name: "Locadora X" }, 1);
    await actions.saveIdentidadeVisual(fd({ tema: TEMA_PADRAO }));
    const s = await settings.settingsDaEmpresa(1);
    assert.equal(s.identidade_tema, TEMA_PADRAO, "restauração persiste no banco");
    assert.equal(s.company_name, "Locadora X", "a restauração não apaga outras configurações");
    assert.equal(resolverTema(s.identidade_tema).id, TEMA_PADRAO);
  });

  it("a action tem o guard de admin e o validador de paleta no corpo", () => {
    const corpo = ler("src/app/(app)/configuracoes/actions.ts");
    const bloco = corpo.split("export async function saveIdentidadeVisual")[1]?.slice(0, 1400) ?? "";
    assert.ok(bloco.includes("await assertAdmin("), "saveIdentidadeVisual precisa de assertAdmin");
    assert.ok(bloco.includes("temaConhecido("), "precisa validar contra a lista fixa de paletas");
    assert.ok(bloco.includes("setSettings("), "precisa persistir em company_settings");
    assert.ok(bloco.includes("identidade_tema"), "chave correta");
  });
});

/* ================================================================== */
/* 5. Aplicação global dos tokens                                      */
/* ================================================================== */

describe("aplicação global dos tokens", () => {
  it("cenário 9: o override emite exatamente as 23 variáveis do @theme", () => {
    const emitidas = Object.keys(variaveisDoTema(TEMAS.loco));
    assert.equal(emitidas.length, 23);
    const css = ler("src/app/globals.css");
    for (const v of emitidas) {
      assert.ok(css.includes(`${v}:`), `${v} precisa existir em globals.css`);
    }
    const texto = declaracoesDoTema(TEMAS["azul-corporativo"]);
    for (const v of emitidas) assert.ok(texto.includes(`${v}:`), `${v} ausente na sobrescrita`);
  });

  it("cenário 9: a folha de estilo é um :root completo e autocontido", () => {
    const css = cssDoTema(TEMAS["verde-petroleo"]);
    assert.ok(css.startsWith(":root{") && css.endsWith("}"));
    assert.equal((css.match(/#/g) || []).length, 23, "só as 23 cores do tema");
    assert.ok(!/[{}]/.test(declaracoesDoTema(TEMAS["verde-petroleo"])), "sem seletor nas declarações");
  });

  it("cenário 9: os tokens de marca estão nos pontos centrais da interface", () => {
    const shell = ler("src/components/Shell.tsx");
    const ui = ler("src/components/ui.tsx");
    for (const trecho of ["bg-marca-600", "text-tinta-900", "border-nuvem-300", "bg-nuvem-100"]) {
      assert.ok(shell.includes(trecho), `Shell.tsx precisa usar ${trecho}`);
    }
    assert.ok(ui.includes("bg-marca-600 text-white hover:bg-marca-700"), "botão primário tokenizado");
    assert.ok(ui.includes("border-nuvem-300"), "borda dos cartões tokenizada");
    // corpo, foco e campo saem de globals.css já em variável
    const globals = ler("src/app/globals.css");
    assert.ok(globals.includes("background: var(--color-nuvem-100)"), "fundo da aplicação tokenizado");
    assert.ok(globals.includes("outline: 2px solid var(--color-marca-600)"), "anel de foco tokenizado");
    assert.ok(globals.includes("border-color: var(--color-marca-500)"), "foco do campo tokenizado");
  });

  it("cenário 10: estados semânticos continuam fora da personalização", async () => {
    // nenhuma paleta emite variável semântica ou neutra de texto
    for (const t of LISTA_TEMAS) {
      const chaves = Object.keys(variaveisDoTema(t));
      for (const proibida of ["red", "emerald", "amber", "sky", "violet", "stone", "slate", "terracota"]) {
        assert.ok(
          !chaves.some((c) => c.startsWith(`--color-${proibida}-`)),
          `${t.id} não pode sobrescrever --color-${proibida}-*`,
        );
      }
    }
    // os tons de status não usam nenhum token personalizável
    const { TONE_CLASS, TONE_DOT } = await import("../src/lib/domain.ts");
    for (const [tom, classe] of Object.entries<string>(TONE_CLASS)) {
      assert.ok(
        !/(marca|destaque|nuvem|tinta)-\d/.test(classe),
        `o tom ${tom} não pode depender de token personalizável: ${classe}`,
      );
    }
    for (const [tom, classe] of Object.entries<string>(TONE_DOT)) {
      assert.ok(!/(marca|destaque|nuvem|tinta)-\d/.test(classe), `o ponto do tom ${tom}: ${classe}`);
    }
    // o terracota ganhou variáveis próprias (fixas): continua distinguível
    assert.ok(TONE_CLASS.terracota.includes("terracota-"), "terracota é fixo");
    assert.ok(TONE_DOT.terracota.includes("terracota-"), "ponto do terracota é fixo");
  });
});

/* ================================================================== */
/* 6. Escopo: só a área autenticada do locador                        */
/* ================================================================== */

describe("escopo do tema", () => {
  it("cenário 12: apenas o layout do grupo (app) emite o override", () => {
    const app = ler("src/app/(app)/layout.tsx");
    assert.ok(app.includes("cssDoTema(tema)"), "o layout autenticado é quem aplica");
    assert.ok(
      app.includes("resolverTema(settings.identidade_tema)"),
      "o id vem das settings da SESSÃO, nunca do request",
    );
    for (const fora of [
      "src/app/(saas)/layout.tsx",
      "src/app/layout.tsx",
      "src/app/login/page.tsx",
      "src/app/planos/page.tsx",
      "src/app/portal/(area)/layout.tsx",
    ]) {
      const corpo = ler(fora);
      assert.ok(!corpo.includes("cssDoTema"), `${fora} não pode herdar o tema do tenant`);
      assert.ok(!corpo.includes("identidade_tema"), `${fora} não pode ler a chave`);
    }
  });

  it("cenário 12: a aba só existe para administrador", () => {
    const pagina = ler("src/app/(app)/configuracoes/page.tsx");
    assert.ok(
      pagina.includes('...(admin ? [{ value: "identidade", label: "Identidade visual" }] : [])'),
      "a aba é admin-only",
    );
    assert.ok(
      pagina.includes('{aba === "identidade" && admin && <IdentidadeVisual'),
      "o conteúdo exige admin",
    );
  });

  it("cenário 12: nenhuma página pública referencia a chave do tema", () => {
    for (const publica of [
      "src/app/login/page.tsx",
      "src/app/planos/page.tsx",
      "src/app/assinar/page.tsx",
      "src/app/portal/(area)/layout.tsx",
      "src/components/SaasShell.tsx",
      "src/app/globals.css",
    ]) {
      assert.ok(!ler(publica).includes("identidade_tema"), `${publica} não pode ler a chave`);
    }
  });
});

/* ================================================================== */
/* 7. Hidratação e prévia                                              */
/* ================================================================== */

describe("hidratação, prévia e ausência de flash", () => {
  it("cenário 11: o override nasce no server component, não no cliente", () => {
    const app = ler("src/app/(app)/layout.tsx");
    assert.ok(!app.includes('"use client"'), "o layout continua server component");
    assert.ok(
      /\{tema\.id !== TEMA_PADRAO && <style data-tema-tenant/.test(app),
      "o <style> é emitido direto no JSX do servidor",
    );
    assert.ok(app.includes('export const dynamic = "force-dynamic"'), "relê o banco a cada request");
  });

  it("cenário 11: nada de localStorage/sessionStorage como fonte do tema", () => {
    const fonte = [
      ler("src/app/(app)/configuracoes/IdentidadeVisual.tsx"),
      ler("src/app/(app)/layout.tsx"),
      ler("src/lib/temas.ts"),
    ].join("\n");
    assert.ok(!/localStorage|sessionStorage/.test(fonte), "a configuração vive no banco");
  });

  it("cenário 11: a prévia é temporária e é removida ao sair da tela", () => {
    const ui = ler("src/app/(app)/configuracoes/IdentidadeVisual.tsx");
    assert.ok(ui.includes("useEffect"), "a prévia só existe em efeito (cliente)");
    assert.ok(ui.includes("removeProperty"), "as variáveis são removidas na limpeza do efeito");
    // a gravação acontece só no submit do formulário
    assert.ok(/<form action=\{saveIdentidadeVisual\}>/.test(ui), "salvar é ação explícita");
    assert.ok(ui.includes('value={TEMA_PADRAO}'), "restaurar é uma ação simples, sempre disponível");
    assert.ok(ui.includes("data-testid=\"previa-identidade\""), "prévia representativa existe");
    // a prévia precisa mostrar estrutura, não só amostras de cor
    for (const trecho of ["cartao", "campo", "rotulo", "BTN.primario", "bg-marca-600", "border-nuvem-300"]) {
      assert.ok(ui.includes(trecho), `a prévia precisa mostrar ${trecho}`);
    }
  });

  it("cenário 11: sem <style> quando o tema é o padrão (nenhum resíduo no HTML)", () => {
    const app = ler("src/app/(app)/layout.tsx");
    assert.ok(
      app.includes("tema.id !== TEMA_PADRAO"),
      "restaurar o Locô não pode deixar override no documento",
    );
  });
});