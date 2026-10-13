/**
 * Configurações operacionais por empresa (Configurações → Operação).
 *
 * Cobre a ponta a ponta pedida para este recurso:
 *  - clientes atuais continuam vendo exatamente os rótulos e campos de hoje
 *    (padrão = comportamento atual, sem nenhuma linha op_* no banco);
 *  - uma empresa de carretinhas usa nomenclaturas e visibilidade diferentes;
 *  - a personalização de uma empresa não vaza para outra (isolamento);
 *  - as configurações persistem (company_settings) e sobrevivem à "recarga";
 *  - a validação do servidor rejeita lixo e normaliza os valores;
 *  - a restauração de padrões não apaga dados de reservas/cauções;
 *  - desativar montagem/caução não altera registros existentes;
 *  - o período da locação continua usando delivery_at/pickup_at e atravessa
 *    dias diferentes, com ou sem o campo de evento visível.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "./helpers/d1.ts";
import { all, insert, one, run } from "../src/lib/db.ts";
import { getSettings, setSettings, DEFAULT_SETTINGS } from "../src/lib/settings.ts";
import {
  OPERACAO_PADRAO,
  OPERACAO_KEYS,
  PERFIS,
  ROTULOS_PADRAO,
  ROTULO_KEY,
  VIS_KEY,
  classificarPerfil,
  dataEventoOuInicio,
  nomeOperacao,
  nomeOperacoesPlural,
  pluralizar,
  resolverOperacao,
  rotuloOu,
  statusReserva,
  tituloOperacoes,
  validarOperacaoForm,
} from "../src/lib/operacao.ts";
import { RESERVATION_STATUS } from "../src/lib/domain.ts";
import { getOperacao, operacaoDaEmpresa, restaurarOperacaoConfig, salvarOperacaoConfig } from "../src/lib/operacao-db.ts";
import { windowError } from "../src/lib/availability-time.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let cliente = 0;
let reserva = 0;

async function cenario() {
  createTestDb();
  await run(`DELETE FROM company_settings`);
  await run(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
  cliente = await insert(`INSERT INTO customers (name, phone) VALUES ('Joao Ribeiro','11999990000')`);
  reserva = await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, delivery_at, pickup_at, total_cents)
     VALUES ('LIMA-001', ?, 'confirmada', '2026-10-10', '2026-10-10T08:00', '2026-10-12T18:00', 50000)`,
    [cliente],
  );
  await run(`INSERT INTO deposits (reservation_id, amount_cents, status, company_id) VALUES (?, 20000, 'recebida', 1)`, [reserva]);
}

describe("padrão compatível com os clientes atuais", () => {
  beforeEach(cenario);

  it("empresa sem nenhuma configuração op_* vê exatamente o sistema de hoje", async () => {
    const op = await getOperacao(); // sem nenhuma linha op_* no banco
    assert.deepEqual(op.rotulos, { ...ROTULOS_PADRAO });
    assert.equal(op.rotulos.evento, "Data do evento");
    assert.equal(op.rotulos.inicio, "Entrega em");
    assert.equal(op.rotulos.fim, "Retirada em");
    assert.deepEqual(op.vis, { evento: true, endereco: true, montagem: true, caucao: true });
    assert.equal(op.perfil, "festas");
  });

  it("nenhuma opção aparece como personalizada no padrão", () => {
    const op = resolverOperacao({});
    assert.ok(
      Object.values(op.personalizado).every((v) => v === false),
      "padrão não pode sinalizar personalização",
    );
  });

  it("settings desconhecidas não entram: a whitelist só grava chaves op_* conhecidas", async () => {
    await setSettings({ "op_rotulo_inicio": "Início da locação", "op_inexistente": "x" } as any);
    const linha = await one<any>(
      `SELECT value FROM company_settings WHERE company_id = 1 AND key = 'op_inexistente'`,
    );
    assert.equal(linha, undefined, "chave fora da whitelist não pode ser persistida");
    assert.equal((await getOperacao()).rotulos.inicio, "Início da locação");
  });

  it("os defaults do sistema (DEFAULT_SETTINGS) já conhecem as chaves operacionais", () => {
    for (const key of Object.values(OPERACAO_KEYS)) assert.ok(key in DEFAULT_SETTINGS, `${key} na whitelist`);
  });
});

describe("perfil de carretinhas e reboques", () => {
  beforeEach(cenario);

  it("preset aplica rótulos e oculta evento, endereço, montagem e caução", () => {
    const op = resolverOperacao({
      op_rotulo_inicio: PERFIS.carretinhas.rotulos.inicio,
      op_rotulo_fim: PERFIS.carretinhas.rotulos.fim,
      op_rotulo_evento: PERFIS.carretinhas.rotulos.evento,
      op_rotulo_evento_hora: PERFIS.carretinhas.rotulos.evento_hora,
      op_rotulo_op_inicio: PERFIS.carretinhas.rotulos.operacao_inicio,
      op_rotulo_op_fim: PERFIS.carretinhas.rotulos.operacao_fim,
      op_vis_evento: "0",
      op_vis_endereco: "0",
      op_vis_montagem: "0",
      op_vis_caucao: "0",
    });
    assert.equal(op.perfil, "carretinhas");
    assert.equal(op.rotulos.inicio, "Data e horário da retirada");
    assert.equal(op.rotulos.fim, "Data e horário da devolução");
    assert.equal(op.rotulos.operacao_inicio, "Retirada");
    assert.equal(op.rotulos.operacao_fim, "Devolução");
    assert.deepEqual(op.vis, { evento: false, endereco: false, montagem: false, caucao: false });
  });

  it("perfil carretinhas de uma empresa não muda o que a empresa de festas vê", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Carretinhas ZB', 1)`);
    await setSettings(
      {
        op_rotulo_evento: PERFIS.carretinhas.rotulos.evento,
        op_rotulo_evento_hora: PERFIS.carretinhas.rotulos.evento_hora,
        op_rotulo_inicio: PERFIS.carretinhas.rotulos.inicio,
        op_rotulo_fim: PERFIS.carretinhas.rotulos.fim,
        op_rotulo_op_inicio: PERFIS.carretinhas.rotulos.operacao_inicio,
        op_rotulo_op_fim: PERFIS.carretinhas.rotulos.operacao_fim,
        op_vis_evento: "0",
        op_vis_endereco: "0",
        op_vis_montagem: "0",
        op_vis_caucao: "0",
      },
      2,
    );
    const daZb = await operacaoDaEmpresa(2);
    const daFesta = await operacaoDaEmpresa(1);
    assert.equal(daZb.perfil, "carretinhas");
    assert.equal(daFesta.perfil, "festas");
    assert.deepEqual(daFesta.rotulos, { ...ROTULOS_PADRAO }, "empresa 1 continua com o padrão");
    assert.deepEqual(daFesta.vis, { evento: true, endereco: true, montagem: true, caucao: true });
    // as linhas gravadas pertencem só à empresa 2
    const linhas1 = await all(`SELECT key FROM company_settings WHERE company_id = 1 AND key LIKE 'op_%'`);
    assert.equal(linhas1.length, 0);
  });

  it("perfil festas (preset explícito) difere do texto legado, mas mantém tudo visível", () => {
    const op = resolverOperacao({
      op_rotulo_evento: PERFIS.festas.rotulos.evento,
      op_rotulo_inicio: PERFIS.festas.rotulos.inicio,
      op_rotulo_fim: PERFIS.festas.rotulos.fim,
    });
    assert.equal(op.perfil, "festas");
    assert.equal(op.rotulos.evento, "Data e horário do evento");
    assert.deepEqual(op.vis, { evento: true, endereco: true, montagem: true, caucao: true });
    // superfície que não foi personalizada continua com o texto legado dela
    assert.equal(rotuloOu(op, "inicio", "Entrega prevista"), "Data e horário da entrega");
  });

  it("classificação: combinação qualquer fora dos presets é personalizado", () => {
    const op = resolverOperacao({ op_vis_caucao: "0" });
    assert.equal(op.perfil, "personalizado");
    assert.equal(op.personalizado.caucao, true);
    assert.equal(op.personalizado.inicio, false);
  });

  it("classificarPerfil não fica defasado: recalcula pelos valores efetivos", () => {
    assert.equal(classificarPerfil(PERFIS.carretinhas.rotulos, PERFIS.carretinhas.vis), "carretinhas");
    assert.equal(classificarPerfil(ROTULOS_PADRAO, { ...OPERACAO_PADRAO.vis, caucao: false }), "personalizado");
  });
});

describe("persistência e rótulos legados por superfície", () => {
  beforeEach(cenario);

  it("o que o administrador salva volta em leituras seguintes (persiste)", async () => {
    await setSettings({ op_rotulo_inicio: "Retirada do cliente", op_vis_endereco: "0" });
    // nova "leitura de request": o resolver parte sempre do banco
    const recarregado = await getOperacao();
    assert.equal(recarregado.rotulos.inicio, "Retirada do cliente");
    assert.equal(recarregado.vis.endereco, false);
    assert.equal(recarregado.personalizado.inicio, true);
    // e o getSettings continua sendo a mesma fonte para o resto do sistema
    assert.equal((await getSettings()).op_rotulo_inicio, "Retirada do cliente");
  });

  it("rótulo gravado igual ao padrão conta como padrão (não sinaliza personalizado)", () => {
    const op = resolverOperacao({ op_rotulo_inicio: ROTULOS_PADRAO.inicio });
    assert.equal(op.personalizado.inicio, false);
    // superfície com texto próprio mantém o legado quando nada foi personalizado
    assert.equal(rotuloOu(op, "inicio", "Entrega prevista"), "Entrega prevista");
    assert.equal(rotuloOu(op, "inicio", "Entrega em"), "Entrega em");
  });

  it("reserva e orçamento resolvem o MESMO rótulo a partir da mesma configuração", () => {
    const op = resolverOperacao({ op_rotulo_inicio: "Início da locação" });
    const naReserva = op.rotulos.inicio;
    const noOrcamento = rotuloOu(op, "inicio", "Entrega prevista");
    assert.equal(naReserva, "Início da locação");
    assert.equal(noOrcamento, "Início da locação");
  });
});

describe("campo de evento oculto — dados internos estáveis", () => {
  beforeEach(cenario);

  it("sem evento visível, a data do evento deriva do início da locação", () => {
    assert.equal(dataEventoOuInicio("", "2026-11-05T09:30"), "2026-11-05");
    assert.equal(dataEventoOuInicio(null, "2026-11-05T09:30"), "2026-11-05");
    assert.equal(dataEventoOuInicio("", ""), "");
  });

  it("com evento informado, nada é sobrescrito", () => {
    assert.equal(dataEventoOuInicio("2026-12-24", "2026-12-23T09:00"), "2026-12-24");
  });

  it("o período continua em delivery_at/pickup_at e atravessa dias diferentes", () => {
    // janela de 3 dias (início e fim em dias diferentes) continua válida
    assert.equal(windowError("2026-11-05T09:00", "2026-11-07T17:00"), null);
    // e a ordem invertida continua sendo recusada, como sempre
    assert.ok(windowError("2026-11-07T17:00", "2026-11-05T09:00"));
  });

  it("a configuração não altera o registro existente", async () => {
    await setSettings({ op_vis_evento: "0" });
    const r = await one<any>(`SELECT event_date, delivery_at, pickup_at FROM reservations WHERE id = ?`, [reserva]);
    assert.equal(r.event_date, "2026-10-10", "ocultar o campo não mexe no dado gravado");
    assert.equal(r.delivery_at, "2026-10-10T08:00");
    assert.equal(r.pickup_at, "2026-10-12T18:00");
  });
});

describe("validação no servidor", () => {
  it("rótulo muito longo é recusado", () => {
    const r = validarOperacaoForm({ op_rotulo_inicio: "x".repeat(61) });
    assert.equal(r.ok, false);
  });

  it("caracteres de controle são removidos e o valor é normalizado", () => {
    const r = validarOperacaoForm({ op_perfil: "personalizado", op_rotulo_inicio: "  Início\r\n da locação\u0000 " });
    assert.ok(r.ok);
    assert.equal((r as any).values.op_rotulo_inicio, "Início da locação");
  });

  it("rótulo vazio é aceito e gravado como vazio (volta ao padrão)", () => {
    const r = validarOperacaoForm({ op_perfil: "personalizado", op_rotulo_inicio: "   " });
    assert.ok(r.ok);
    assert.equal((r as any).values.op_rotulo_inicio, "");
  });

  it("visibilidade só aceita checkbox marcado como visível", () => {
    const r = validarOperacaoForm({ op_perfil: "personalizado", op_vis_evento: "1", op_vis_endereco: "qualquer" });
    assert.ok(r.ok);
    assert.equal((r as any).values.op_vis_evento, "1");
    assert.equal((r as any).values.op_vis_endereco, "0");
    assert.equal((r as any).values.op_vis_caucao, "0", "ausente = oculto no formulário");
  });

  it("perfil inválido é recusado no servidor", () => {
    const r = validarOperacaoForm({ op_perfil: "qualquercoisa" });
    assert.equal(r.ok, false);
    const semPerfil = validarOperacaoForm({});
    assert.equal(semPerfil.ok, false);
  });

  it("o que passa na validação é exatamente o que o resolver lê", async () => {
    const r = validarOperacaoForm({ op_perfil: "personalizado", op_rotulo_fim: "Devolução", op_vis_montagem: "1" });
    assert.ok(r.ok);
    await setSettings((r as any).values);
    const op = await getOperacao();
    assert.equal(op.rotulos.fim, "Devolução");
    assert.equal(op.vis.montagem, true);
  });
});

describe("restauração de padrões e preservação de dados", () => {
  beforeEach(cenario);

  it("restaurar volta os rótulos ao padrão sem tocar em reservas, cauções e cobranças", async () => {
    await setSettings({
      op_rotulo_inicio: "Retirada do cliente",
      op_rotulo_fim: "Devolução",
      op_vis_evento: "0",
      op_vis_endereco: "0",
      op_vis_montagem: "0",
      op_vis_caucao: "0",
    });
    const antes = await one<any>(
      `SELECT event_date, delivery_at, pickup_at, total_cents FROM reservations WHERE id = ?`,
      [reserva],
    );
    const depositoAntes = await one<any>(`SELECT amount_cents, status FROM deposits WHERE reservation_id = ?`, [reserva]);

    await restaurarOperacaoConfig(1);

    const op = await getOperacao();
    assert.deepEqual(op.rotulos, { ...ROTULOS_PADRAO });
    assert.deepEqual(op.vis, { evento: true, endereco: true, montagem: true, caucao: true });
    assert.equal(op.perfil, "festas");

    const depois = await one<any>(
      `SELECT event_date, delivery_at, pickup_at, total_cents FROM reservations WHERE id = ?`,
      [reserva],
    );
    const depositoDepois = await one<any>(`SELECT amount_cents, status FROM deposits WHERE reservation_id = ?`, [reserva]);
    assert.deepEqual(depois, antes, "restaurar padrões não altera a reserva");
    assert.deepEqual(depositoDepois, depositoAntes, "restaurar padrões não altera a caução");
  });

  it("restaurar só apaga chaves op_* da própria empresa", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Carretinhas ZB', 1)`);
    await setSettings({ op_rotulo_fim: "Devolução" }, 2);
    await setSettings({ op_rotulo_fim: "Devolução" }, 1);

    await restaurarOperacaoConfig(1);

    assert.equal((await operacaoDaEmpresa(1)).rotulos.fim, ROTULOS_PADRAO.fim);
    assert.equal((await operacaoDaEmpresa(2)).rotulos.fim, "Devolução", "outra empresa intacta");
    const restantes = await all(`SELECT key FROM company_settings WHERE company_id = 1 AND key LIKE 'op_%'`);
    assert.equal(restantes.length, 0);
  });

  it("desativar caução/montagem não altera cauções e valores já lançados", async () => {
    await run(`UPDATE reservations SET assembly_cents = 7500 WHERE id = ?`, [reserva]);
    await setSettings({ op_vis_caucao: "0", op_vis_montagem: "0", op_vis_evento: "0", op_vis_endereco: "0" });

    const r = await one<any>(`SELECT assembly_cents, total_cents FROM reservations WHERE id = ?`, [reserva]);
    const dep = await one<any>(`SELECT amount_cents, status FROM deposits WHERE reservation_id = ?`, [reserva]);
    assert.equal(r.assembly_cents, 7500, "valor de montagem lançado permanece");
    assert.equal(dep.amount_cents, 20000, "caução recebida permanece");
    assert.equal(dep.status, "recebida", "status da caução permanece");

    const op = await getOperacao();
    assert.equal(op.vis.caucao, false);
    assert.equal(op.vis.montagem, false);
  });
});

/* ------------------------------------------------------------------ */
/* Auditoria de perfis: nomes das operações, perfil salvo e salvamento */
/* ------------------------------------------------------------------ */

/** Campos de formulário equivalentes ao preset (o que o painel envia). */
function presetFields(p: "festas" | "carretinhas"): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(PERFIS[p].rotulos) as (keyof typeof ROTULO_KEY)[]) {
    out[ROTULO_KEY[k]] = PERFIS[p].rotulos[k];
  }
  for (const k of Object.keys(PERFIS[p].vis) as (keyof typeof VIS_KEY)[]) {
    out[VIS_KEY[k]] = PERFIS[p].vis[k] ? "1" : "0";
  }
  return out;
}

describe("nomes das operações (início e fim) em toda a aplicação", () => {
  beforeEach(cenario);

  it("padrão: checkboxes, menu e cartões exibem exatamente os textos atuais", async () => {
    const op = await getOperacao();
    assert.equal(op.rotulos.operacao_inicio, "Entrega");
    assert.equal(op.rotulos.operacao_fim, "Retirada");
    assert.equal(tituloOperacoes(op), "Entregas e Retiradas", "menu continua igual para clientes atuais");
    assert.equal(nomeOperacao(op, "entrega"), "Entrega");
    assert.equal(nomeOperacao(op, "retirada"), "Retirada");
    assert.equal(nomeOperacoesPlural(op, "entrega"), "Entregas");
    assert.equal(nomeOperacoesPlural(op, "retirada"), "Retiradas");
    // montagem/desmontagem continuam com o rótulo do domínio
    assert.equal(nomeOperacao(op, "montagem"), null);
    assert.equal(nomeOperacao(op, "desmontagem"), null);
  });

  it("carretinhas: checkboxes, menu e status mostram retirada e devolução", async () => {
    await salvarOperacaoConfig({ op_perfil: "carretinhas", ...presetFields("carretinhas") }, 1);
    const op = await getOperacao();
    assert.equal(op.rotulos.operacao_inicio, "Retirada");
    assert.equal(op.rotulos.operacao_fim, "Devolução");
    assert.equal(tituloOperacoes(op), "Retiradas e Devoluções", "menu acompanha o perfil");
    const status = statusReserva(op, RESERVATION_STATUS);
    assert.equal(status.find((s) => s.value === "retirada")!.label, "Devolução");
    assert.equal(status.find((s) => s.value === "aguardando_retirada")!.label, "Aguardando devolução");
    // os VALORES internos dos status não mudam — só o texto
    assert.deepEqual(status.map((s) => s.value), RESERVATION_STATUS.map((s) => s.value));
  });

  it("empresas de festas continuam com os rótulos de status atuais, letra por letra", async () => {
    const op = await getOperacao();
    const status = statusReserva(op, RESERVATION_STATUS);
    assert.deepEqual(status.map((s) => s.label), RESERVATION_STATUS.map((s) => s.label));
  });

  it("plural simples cobre os nomes dos perfis", () => {
    assert.equal(pluralizar("Entrega"), "Entregas");
    assert.equal(pluralizar("Retirada"), "Retiradas");
    assert.equal(pluralizar("Devolução"), "Devoluções");
    assert.equal(pluralizar("Busca"), "Buscas");
  });
});

describe("perfil salvo (op_perfil) e personalizado de primeira classe", () => {
  beforeEach(cenario);

  it("'Personalizado' escolhido persiste mesmo coincidindo com um preset", async () => {
    const r = validarOperacaoForm({ op_perfil: "personalizado", ...presetFields("carretinhas") });
    assert.ok(r.ok);
    assert.equal((r as any).values.op_perfil, "personalizado");
    await salvarOperacaoConfig((r as any).values, 1);
    const op = await getOperacao();
    assert.equal(op.perfil, "personalizado", "o perfil gravado não é reclassificado pela leitura");
  });

  it("preset escolhido com valores divergentes é gravado como personalizado", () => {
    const r = validarOperacaoForm({ op_perfil: "carretinhas", ...presetFields("carretinhas"), op_rotulo_fim: "Entrega de volta" });
    assert.ok(r.ok);
    assert.equal((r as any).values.op_perfil, "personalizado");
  });

  it("preset coerente é gravado como o próprio preset", () => {
    const r = validarOperacaoForm({ op_perfil: "festas", ...presetFields("festas") });
    assert.ok(r.ok);
    assert.equal((r as any).values.op_perfil, "festas");
  });

  it("trocar de perfil várias vezes: a última gravação vence, sem resíduo", async () => {
    for (const p of ["carretinhas", "festas", "carretinhas"] as const) {
      const r = validarOperacaoForm({ op_perfil: p, ...presetFields(p) });
      assert.ok(r.ok);
      await salvarOperacaoConfig((r as any).values, 1);
      const visto = await getOperacao();
      assert.equal(visto.perfil, p, `logo após salvar ${p}`);
    }
    const op = await getOperacao();
    assert.equal(op.rotulos.operacao_fim, "Devolução");
    assert.equal(op.vis.caucao, false);
  });

  it("sem op_perfil (empresas anteriores à chave) o perfil deriva dos valores", () => {
    assert.equal(resolverOperacao({}).perfil, "festas");
    assert.equal(resolverOperacao({ op_vis_caucao: "0" }).perfil, "personalizado");
  });

  it("salvar sem alteração não gera nova escrita (batch só das chaves mudadas)", async () => {
    const valores = { op_perfil: "carretinhas", ...presetFields("carretinhas") };
    await salvarOperacaoConfig(valores, 1);
    const rev1 = await one<any>(`SELECT revision FROM stock_revision WHERE id = 1`);
    await salvarOperacaoConfig({ ...valores }, 1); // idêntico: nada a gravar
    const rev2 = await one<any>(`SELECT revision FROM stock_revision WHERE id = 1`);
    assert.equal(rev2.revision, rev1.revision, "segundo salvamento idêntico não toca o banco");
  });

  it("restaurar limpa também o perfil salvo e devolve o padrão", async () => {
    await salvarOperacaoConfig({ op_perfil: "personalizado", op_rotulo_fim: "Entrega de volta" }, 1);
    await restaurarOperacaoConfig(1);
    const op = await getOperacao();
    assert.equal(op.perfil, "festas");
    assert.equal(op.rotulos.fim, ROTULOS_PADRAO.fim);
    assert.equal(op.rotulos.operacao_fim, ROTULOS_PADRAO.operacao_fim);
  });

  it("salvar na empresa 2 não toca a empresa 1 (escrita sempre com company_id)", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2, 'ZB', 1)`);
    await salvarOperacaoConfig({ op_perfil: "carretinhas", ...presetFields("carretinhas") }, 2);
    assert.equal((await operacaoDaEmpresa(2)).perfil, "carretinhas");
    assert.equal((await operacaoDaEmpresa(1)).perfil, "festas");
    assert.equal((await operacaoDaEmpresa(1)).rotulos.operacao_fim, "Retirada");
  });
});

/* ------------------------------------------------------------------ */
/* Contrato do formulário do painel (cliente → FormData → servidor)   */
/* ------------------------------------------------------------------ */

/**
 * Regressão do bug em que NENHUMA configuração operacional salvava:
 * o perfil vivia só no state do React e nunca entrava no FormData, então o
 * servidor recebia o form sem `op_perfil`, `perfilSalvo()` devolvia null e a
 * action recusava tudo com "Perfil operacional inválido" — idêntico em web
 * e mobile (o erro era do servidor, não do dispositivo). Os testes de
 * `validarOperacaoForm` passavam porque injetavam `op_perfil` à mão; nada
 * cobrava que o FORMULÁRIO enviasse os campos que o servidor exige.
 */
describe("formulário do painel envia o que o servidor valida", () => {
  const fonte = fs.readFileSync(
    path.join(ROOT, "src/app/(app)/configuracoes/OperacaoSettings.tsx"),
    "utf8",
  );
  const inicio = fonte.indexOf('<form action={submitSalvar}');
  const form = fonte.slice(inicio, fonte.indexOf("</form>", inicio));

  it("o form de salvar carrega o perfil escolhido como campo (op_perfil)", () => {
    assert.ok(inicio >= 0, "form action={submitSalvar} sumiu do painel");
    assert.ok(
      form.includes('type="hidden"') && form.includes("name={OPERACAO_KEYS.perfil}"),
      "o form precisa enviar name={OPERACAO_KEYS.perfil} (hidden): sem esse campo " +
        "no FormData o servidor recusa o salvamento inteiro com " +
        '"Perfil operacional inválido"',
    );
  });

  it('os checkboxes de visibilidade enviam value="1" (é o único valor que o servidor lê como visível)', () => {
    // os 4 checkboxes vêm de um único <input> dentro do map de CAMPOS_VIS
    const inputs = form.match(/<input\s[\s\S]*?\/>/g) ?? [];
    const checkbox = inputs.find((i) => i.includes('type="checkbox"'));
    assert.ok(checkbox, "input dos checkboxes de visibilidade sumiu do form");
    assert.ok(
      checkbox.includes("name={VIS_KEY[chave]}") && checkbox.includes('value="1"'),
      'checkbox sem value="1" (o mapa CAMPOS_VIS renderiza os 4): marcado, ' +
        'o navegador envia "on" e o servidor grava oculto — salvaria errado em silêncio',
    );
  });
});
