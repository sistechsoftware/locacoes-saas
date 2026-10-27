/**
 * Configuração de e-mails POR EMPRESA (Configurações > Notificações > E-mails).
 *
 * Trava o que não pode mudar sem ninguém perceber:
 *  - o interruptor geral nasce DESLIGADO (nenhum envio real automático);
 *  - as chaves email_* passam pela whitelist de setSettings e vivem no MESMO
 *    company_settings multi-tenant dos demais ajustes;
 *  - a configuração de uma empresa nunca altera a da outra;
 *  - antecedências/hora/fuso/limite são validados e caem no padrão quando
 *    inválidos (configuração quebrada não silencia nem infla a fila);
 *  - o interruptor de um grupo/tipo não afeta os demais.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { resetCompanyCache, run, runWithCompany, setCompanySettings, scalar } from "../src/lib/db.ts";
import {
  antecedenciasValidas,
  avisosDeConfiguracao,
  chaveDoTipo,
  MAX_ANTECEDENCIAS,
  PADRAO_ANTECEDENCIA_OPERACAO,
  PADRAO_ANTECEDENCIA_RESERVA,
  parseAntecedencias,
  resolverConfigEmail,
  TIPOS_EMAIL,
  tipoLigado,
} from "../src/lib/email-notificacoes.ts";
import { setSettings, settingsDaEmpresa, DEFAULT_SETTINGS } from "../src/lib/settings.ts";
import { agendarLembrete, epochDeWallClock, wallClockIso, fusoSeguro, sufixoFuso } from "../src/lib/email-tempo.ts";

const FUSO = "America/Sao_Paulo";

beforeEach(() => {
  createTestDb();
  resetCompanyCache();
});
afterEach(() => {
  resetTestDb();
  resetCompanyCache();
});

describe("configuração padrão", () => {
  it("o interruptor geral nasce DESLIGADO", () => {
    const cfg = resolverConfigEmail({});
    assert.equal(cfg.ativo, false, "empresa que nunca abriu a tela não pode estar enviando");
    assert.equal(DEFAULT_SETTINGS.email_enabled, "0");
  });

  it("com o master ligado, os tipos seguem o padrão documentado", () => {
    const cfg = resolverConfigEmail({ email_enabled: "1" });
    assert.equal(cfg.ativo, true);
    assert.equal(cfg.tipos.reserva_confirmacao, true);
    assert.equal(cfg.tipos.reserva_lembrete, true);
    assert.equal(cfg.tipos.operacao_concluida, true);
    assert.equal(cfg.tipos.fidelidade_conquista, true);
    // a única exceção é o atraso, que só avisa se a empresa ligar
    assert.equal(cfg.tipos.operacao_atrasada, false);
  });

  it("grupo desligado desliga os tipos do grupo, um a um", () => {
    const cfg = resolverConfigEmail({ email_enabled: "1", email_grupo_reservas: "0" });
    assert.equal(tipoLigado(cfg, "reserva_confirmacao"), false);
    assert.equal(tipoLigado(cfg, "reserva_lembrete"), false);
    // os outros grupos continuam de pé
    assert.equal(tipoLigado(cfg, "operacao_concluida"), true);
    assert.equal(tipoLigado(cfg, "fidelidade_progresso"), true);
  });

  it("tipo desligado não afeta o irmão ao lado", () => {
    const cfg = resolverConfigEmail({ email_enabled: "1", email_reserva_cancelamento: "0" });
    assert.equal(tipoLigado(cfg, "reserva_cancelamento"), false);
    assert.equal(tipoLigado(cfg, "reserva_confirmacao"), true);
  });

  it("e-mail de teste é independente dos interruptores (ação manual)", () => {
    const cfg = resolverConfigEmail({});
    assert.equal(tipoLigado(cfg, "email_teste"), true, "o teste precisa funcionar antes de ativar");
  });

  it("todos os tipos do catálogo têm chave de configuração e rótulo", () => {
    for (const [tipo, def] of Object.entries(TIPOS_EMAIL)) {
      assert.ok(def.rotulo, `${tipo} sem rótulo`);
      assert.ok(def.descricao, `${tipo} sem descrição`);
      assert.ok(def.grupo, `${tipo} sem grupo`);
      const chave = chaveDoTipo(tipo as never);
      assert.ok(chave.startsWith("email_"), `${tipo} gera chave estranha: ${chave}`);
    }
  });
});

describe("antecedências dos lembretes", () => {
  it("aceita a lista da empresa e ordena da maior para a menor", () => {
    assert.deepEqual(parseAntecedencias("1440,4320", ""), [4320, 1440]);
  });

  it("remove duplicadas e fora da faixa", () => {
    // 2 é menor que a antecedência mínima e 9999999 passa do teto: saem;
    // a lista ainda tem um valor válido, então NÃO cai no padrão
    assert.deepEqual(parseAntecedencias("1440,1440,2,9999999", "60"), [1440]);
  });

  it("valor inválido cai no padrão documentado, nunca em lista vazia", () => {
    assert.deepEqual(parseAntecedencias("abc", PADRAO_ANTECEDENCIA_RESERVA), [4320, 1440]);
    assert.deepEqual(parseAntecedencias("", PADRAO_ANTECEDENCIA_OPERACAO), [1440, 120]);
  });

  it("respeita o limite de lembretes por tipo", () => {
    const quatro = Array.from({ length: 8 }, (_, i) => String((i + 1) * 60)).join(",");
    const lista = parseAntecedencias(quatro, "");
    assert.equal(lista.length, MAX_ANTECEDENCIAS);
    assert.equal(antecedenciasValidas(quatro), false, "mais que o limite é rejeitado pela tela");
    assert.equal(antecedenciasValidas("1440,120"), true);
  });
});

describe("hora de envio e fuso", () => {
  it("lembrete antes da hora de envio espera até ela; depois dela segue o gatilho", () => {
    const gatilho = epochDeWallClock("2026-10-25T06:30", FUSO);
    const adiado = agendarLembrete(gatilho, { horaEnvio: "08:00", fuso: FUSO });
    assert.equal(wallClockIso(adiado, FUSO), "2026-10-25T08:00");

    const tarde = epochDeWallClock("2026-10-25T09:15", FUSO);
    assert.equal(agendarLembrete(tarde, { horaEnvio: "08:00", fuso: FUSO }), tarde);
  });

  it("sufixo de fuso vira o formato que o SQLite entende", () => {
    assert.equal(sufixoFuso(FUSO, Date.now()), "-03:00");
    assert.equal(fusoSeguro("Nada/Errado"), FUSO, "fuso inválido cai no padrão do negócio");
    assert.equal(fusoValidoGuard(FUSO), true);
    assert.equal(fusoValidoGuard("Nada/Errado"), false);
  });
});

function fusoValidoGuard(v: string) {
  // mesmo critério usado pela configuração (email-notificacoes)
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: v });
    return /^[A-Za-z]+\/[A-Za-z_]+$/.test(v);
  } catch {
    return false;
  }
}

describe("persistência multi-tenant", () => {
  it("as chaves email_* entram na whitelist e são gravadas por empresa", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2,'Eventos Zumbi',1)`);
    await setSettings({ email_enabled: "1", email_reserva_lembrete_antecedencias: "720" }, 1);
    await setSettings({ email_enabled: "0", email_grupo_fidelidade: "0" }, 2);

    const a = await settingsDaEmpresa(1);
    const b = await settingsDaEmpresa(2);
    assert.equal(a.email_enabled, "1");
    assert.equal(a.email_reserva_lembrete_antecedencias, "720");
    assert.equal(b.email_enabled, "0", "a configuração da empresa 1 vazou para a 2");
    assert.equal(b.email_reserva_lembrete_antecedencias, "", "chave da empresa 1 não existe na 2");
    assert.equal(b.email_grupo_fidelidade, "0");
    assert.equal(a.email_grupo_fidelidade, "1", "grupo desligado na 2 não desliga o grupo da 1");
  });

  it("chave desconhecida é ignorada (não vira lixo no KV)", async () => {
    await setSettings({ email_enabled: "1", email_nao_existe: "x" } as never, 1);
    const a = await settingsDaEmpresa(1);
    assert.equal(a.email_enabled, "1");
    assert.equal("email_nao_existe" in a, false);
  });

  it("a configuração de uma empresa não decide a da outra no cron", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2,'Eventos Zumbi',1)`);
    await setSettings({ email_enabled: "1" }, 2);
    await setCompanySettings(1, { email_enabled: "0" });
    const na2 = await runWithCompany(2, async () => resolverConfigEmail(await settingsDaEmpresa(2)));
    const na1 = await runWithCompany(1, async () => resolverConfigEmail(await settingsDaEmpresa(1)));
    assert.equal(na2.ativo, true);
    assert.equal(na1.ativo, false);
  });
});

describe("resumo do que impede o envio", () => {
  it("aponta master desligado e provedor não configurado", () => {
    const off = resolverConfigEmail({});
    const avisos1 = avisosDeConfiguracao(off, false);
    assert.ok(avisos1.some((a) => a.chave === "master"));
    assert.ok(avisos1.some((a) => a.chave === "provedor"));

    const on = resolverConfigEmail({ email_enabled: "1" });
    const avisos2 = avisosDeConfiguracao(on, true);
    assert.equal(avisos2.length, 0, "configuração completa não gera alerta");
  });
});

describe("permissões das telas de e-mail", () => {
  const raiz = process.cwd();
  const ler = (p: string) => fs.readFileSync(path.join(raiz, p), "utf8");

  it("salvar configuração exige administrador da empresa", () => {
    const src = ler("src/app/(app)/configuracoes/actions.ts");
    const i = src.indexOf("export async function saveEmailSettings");
    assert.ok(i > 0, "action de configuração não encontrada");
    const corpo = src.slice(i, i + 900);
    assert.ok(corpo.includes("assertAdmin()"), "saveEmailSettings precisa de assertAdmin");
  });

  it("histórico exige o módulo de notificações e o reprocesso exige escrita", () => {
    const pagina = ler("src/app/(app)/notificacoes/emails/page.tsx");
    assert.ok(pagina.includes('requireModule("notificacoes")'), "histórico precisa do guard do módulo");
    assert.ok(!pagina.includes("requireModuleEdit"), "quem só visualiza não pode reprocessar");

    const acoes = ler("src/app/(app)/notificacoes/actions.ts");
    const i = acoes.indexOf("export async function reprocessarEmailAction");
    assert.ok(i > 0, "action de reprocesso não encontrada");
    assert.ok(acoes.slice(i, i + 400).includes("requireModuleEdit(\"notificacoes\")"));
  });

  it("a tela de configuração fica na aba de Configurações (navegação existente)", () => {
    const pagina = ler("src/app/(app)/configuracoes/page.tsx");
    assert.ok(pagina.includes('value: "notificacoes"'), "aba Notificações ausente da lista de abas");
    assert.ok(pagina.includes("<EmailSettings"), "aba sem conteúdo");
  });
});
