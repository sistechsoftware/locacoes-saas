/**
 * Variaveis financeiras do contrato: {{adiantamento_valor}} e {{valor_saldo}}.
 *
 * Regra de negocio coberta aqui:
 *   - o CONTRATO apresenta as condicoes comerciais combinadas na reserva
 *     (valor contratado, adiantamento previsto, saldo contratual previsto);
 *   - o FINANCEIRO registra o que foi efetivamente pago.
 * Uma informacao nao modifica a outra: nenhum pagamento altera as duas
 * variaveis — elas so mudam quando a PROPRIA condicao comercial da reserva
 * muda (adiantamento editado ou cancelado).
 *
 * Origem dos valores: o sistema nao tem percentual de adiantamento
 * configuravel por empresa — a condicao e um VALOR combinado por reserva
 * (form de criacao e secao Adiantamento da tela da reserva), gravado em
 * financial_entries com category='Adiantamento' ou, no cenario "pago agora",
 * no proprio pagamento marcado com notes='Adiantamento' (cenario A de
 * criarAdiantamento). Por isso os testes variam o valor combinado (25%, 50%
 * do total) em vez de um percentual de configuracao.
 *
 * Os dois formatos (impressao e digital) sao cobertos em todos os cenarios,
 * em texto puro e em HTML.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { insert, one } from "../src/lib/db.ts";
import { DEFAULT_SETTINGS, setSettings } from "../src/lib/settings.ts";
import { buildContractBody, buildContractBodyDigital } from "../src/lib/contracts.ts";
import {
  adiantamentoPrevisto,
  atualizarAdiantamentoAgendado,
  cancelarAdiantamentoAgendado,
  confirmarAdiantamento,
  criarAdiantamento,
  percentualAdiantamento,
} from "../src/lib/receber.ts";
import { reservationMoney } from "../src/lib/reservations.ts";
import { messagesForReservation } from "../src/lib/whatsapp.ts";
import { money } from "../src/lib/format.ts";

/* ------------------------------------------------------------------ */
/* Cenario                                                             */
/* ------------------------------------------------------------------ */

let seq = 0;
let cliente = 0;

/** Reserva nova de `totalCents` na empresa 1 (padrao do banco de teste). */
async function reserva(totalCents = 10000): Promise<number> {
  seq++;
  return await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, total_cents)
     VALUES (?,?,'confirmada','2026-10-10',?)`,
    [`LIMA-${String(seq).padStart(3, "0")}`, cliente, totalCents],
  );
}

async function cenario() {
  createTestDb();
  seq = 0;
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
  cliente = await insert(`INSERT INTO customers (name, phone) VALUES ('Joao da Silva','11999990000')`);
  // todo cenario comeca com um modelo que USA as duas variaveis; os testes
  // que precisam de outro texto (HTML, modelo padrao) sobrescrevem depois
  await definirModelos(MODELO);
}

/** Adiantamento combinado e ainda nao recebido (a forma normal de negociar). */
async function adiantamentoAgendado(reservationId: number, amountCents: number) {
  const erro = await criarAdiantamento({
    reservationId,
    amountCents,
    imediato: false,
    dataPrevista: "2026-10-06",
    method: "pix",
    userId: 1,
  });
  assert.equal(erro, null, "adiantamento agendado sem erro");
}

/** Adiantamento combinado e recebido no ato: so o pagamento, sem previsao. */
async function adiantamentoPagoNoAto(reservationId: number, amountCents: number) {
  const erro = await criarAdiantamento({
    reservationId,
    amountCents,
    imediato: true,
    dataPrevista: "2026-10-06",
    method: "pix",
    userId: 1,
  });
  assert.equal(erro, null, "adiantamento pago no ato sem erro");
}

/** Confirmar o recebimento de um adiantamento agendado (vira pagamento). */
async function receberAdiantamento(reservationId: number) {
  const row = await one<any>(
    `SELECT id FROM financial_entries WHERE reservation_id = ? AND category = 'Adiantamento' AND status = 'aberta'`,
    [reservationId],
  );
  assert.ok(row, "ha um adiantamento em aberto para confirmar");
  const erro = await confirmarAdiantamento(row.id, { paidAt: "2026-10-06", userId: 1 });
  assert.equal(erro, null);
}

/** Pagamento comum da reserva (entrada, parcela, quitacao) — nao e adiantamento. */
async function pagamentoComum(reservationId: number, amountCents: number, notes = "saldo") {
  await insert(
    `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, notes, company_id)
     VALUES (?,?, 'pix','2026-10-07',?,1)`,
    [reservationId, amountCents, notes],
  );
}

async function definirModelos(papel: string, digital = papel) {
  await setSettings({ contract_template: papel, contract_template_digital: digital });
}

/** Os dois formatos de contrato, como o sistema os gera. */
async function doisFormatos(reservationId: number) {
  return {
    papel: await buildContractBody(reservationId, "CTR-001"),
    digital: await buildContractBodyDigital(reservationId, "CTR-001", 1),
  };
}

type Esperado = { adiantamento: number; saldo: number; total: number };

/** As tres variaveis financeiras contratuais, dentro dos dois formatos. */
function conferir(corpos: { papel: string; digital: string }, esperado: Esperado) {
  for (const [rotulo, corpo] of [
    ["impressao", corpos.papel],
    ["digital", corpos.digital],
  ] as const) {
    assert.ok(
      corpo.includes(money(esperado.adiantamento)),
      `${rotulo}: adiantamento previsto ${money(esperado.adiantamento)} em "${corpo}"`,
    );
    assert.ok(
      corpo.includes(money(esperado.saldo)),
      `${rotulo}: saldo contratual ${money(esperado.saldo)} em "${corpo}"`,
    );
    assert.ok(
      corpo.includes(money(esperado.total)),
      `${rotulo}: total contratado ${money(esperado.total)} em "${corpo}"`,
    );
    assert.ok(!corpo.includes("{{"), `${rotulo}: nenhuma variavel sobra literal`);
    assert.ok(!corpo.includes("undefined"), `${rotulo}: nada de undefined`);
    assert.ok(!corpo.includes("null"), `${rotulo}: nada de null`);
  }
}

const MODELO = "Total: {{valor_total}} | Adiantamento: {{adiantamento_valor}} | Saldo: {{valor_saldo}}";
const MODELO_HTML = "<p>Total: {{valor_total}} — Adiantamento: {{adiantamento_valor}} — Saldo: {{valor_saldo}}</p>";

/* ------------------------------------------------------------------ */
/* 1. Reserva sem pagamentos registrados                               */
/* ------------------------------------------------------------------ */

describe("reserva sem nenhum pagamento", () => {
  beforeEach(cenario);

  it("apresenta o adiantamento previsto e o saldo contratual nos dois formatos", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);

    conferir(await doisFormatos(r), { adiantamento: 3000, saldo: 7000, total: 10000 });

    const m = await reservationMoney(r);
    assert.equal(m.paid, 0, "nenhum pagamento registrado");
    assert.equal(m.balance, 10000, "o financeiro continua mostrando tudo a receber");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Adiantamento parcial ou integralmente pago                       */
/* ------------------------------------------------------------------ */

describe("adiantamento pago", () => {
  beforeEach(cenario);

  it("confirmado (previsao quitada) nao muda as variaveis contratuais", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);
    assert.equal(await adiantamentoPrevisto(r), 3000);

    await receberAdiantamento(r);

    conferir(await doisFormatos(r), { adiantamento: 3000, saldo: 7000, total: 10000 });

    const m = await reservationMoney(r);
    assert.equal(m.paid, 3000, "o caixa registra o adiantamento recebido");
    assert.equal(m.balance, 7000);
  });

  it("pago no ato na criacao tambem aparece como adiantamento previsto", async () => {
    const r = await reserva(10000);
    await adiantamentoPagoNoAto(r, 3000);

    conferir(await doisFormatos(r), { adiantamento: 3000, saldo: 7000, total: 10000 });
    assert.equal((await reservationMoney(r)).paid, 3000, "no cenario A o dinheiro ja entrou");
  });
});

/* ------------------------------------------------------------------ */
/* 3. Pagamentos adicionais                                             */
/* ------------------------------------------------------------------ */

describe("pagamentos adicionais da reserva", () => {
  beforeEach(cenario);

  it("pagamento comum de R$ 20,00 nao altera adiantamento nem saldo contratual", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);
    await pagamentoComum(r, 2000, "entrada do cliente");

    conferir(await doisFormatos(r), { adiantamento: 3000, saldo: 7000, total: 10000 });

    const m = await reservationMoney(r);
    assert.equal(m.paid, 2000, "o financeiro soma o que entrou");
    assert.equal(m.balance, 8000, "saldo financeiro pendente segue o caixa");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Reserva totalmente quitada antecipadamente                       */
/* ------------------------------------------------------------------ */

describe("reserva quitada antecipadamente", () => {
  beforeEach(cenario);

  it("R$ 100,00 pagos nao viram adiantamento de R$ 100,00 nem zeram o saldo contratual", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);
    await receberAdiantamento(r);
    await pagamentoComum(r, 7000, "quitacao total");

    conferir(await doisFormatos(r), { adiantamento: 3000, saldo: 7000, total: 10000 });

    const m = await reservationMoney(r);
    assert.equal(m.paid, 10000, "financeiro: tudo recebido");
    assert.equal(m.balance, 0, "financeiro: zero a receber");
  });
});

/* ------------------------------------------------------------------ */
/* 5. Reserva sem adiantamento previsto                                */
/* ------------------------------------------------------------------ */

describe("sem adiantamento previsto", () => {
  beforeEach(cenario);

  it("adiantamento zero e saldo igual ao total contratado, nos dois formatos", async () => {
    const r = await reserva(10000);

    conferir(await doisFormatos(r), { adiantamento: 0, saldo: 10000, total: 10000 });
    assert.equal(await adiantamentoPrevisto(r), 0);
  });

  it("pagamento comum nao vira adiantamento previsto", async () => {
    const r = await reserva(10000);
    await pagamentoComum(r, 5000);

    conferir(await doisFormatos(r), { adiantamento: 0, saldo: 10000, total: 10000 });
    const m = await reservationMoney(r);
    assert.equal(m.paid, 5000, "o financeiro continua refletindo o pagamento");
    assert.equal(m.balance, 5000);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Condicao de adiantamento diferente do exemplo de 30%              */
/* ------------------------------------------------------------------ */

describe("valores de adiantamento diferentes do exemplo de 30%", () => {
  beforeEach(cenario);

  it("adiantamento de 25% do total (R$ 25,00) gera saldo de R$ 75,00", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 2500);

    conferir(await doisFormatos(r), { adiantamento: 2500, saldo: 7500, total: 10000 });
  });

  it("adiantamento de 50% do total (R$ 50,00) gera saldo de R$ 50,00", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 5000);

    conferir(await doisFormatos(r), { adiantamento: 5000, saldo: 5000, total: 10000 });
  });

  it("cada reserva usa a sua propria condicao, mesmo com total igual", async () => {
    const a = await reserva(10000);
    const b = await reserva(10000);
    await adiantamentoAgendado(a, 2000);
    await adiantamentoAgendado(b, 4000);

    conferir(await doisFormatos(a), { adiantamento: 2000, saldo: 8000, total: 10000 });
    conferir(await doisFormatos(b), { adiantamento: 4000, saldo: 6000, total: 10000 });
  });
});

/* ------------------------------------------------------------------ */
/* 7. Condicoes comerciais especificas (edicao e cancelamento)          */
/* ------------------------------------------------------------------ */

describe("condicoes comerciais alteradas apos a criacao", () => {
  beforeEach(cenario);

  async function entryDaReserva(reservationId: number) {
    const row = await one<any>(
      `SELECT id FROM financial_entries WHERE reservation_id = ? AND category = 'Adiantamento' ORDER BY id DESC`,
      [reservationId],
    );
    assert.ok(row, "existe lancamento de adiantamento");
    return row;
  }

  it("adiantamento editado passa a valer no contrato", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);
    const row = await entryDaReserva(r);
    const erro = await atualizarAdiantamentoAgendado(row.id, {
      amountCents: 4000,
      dataPrevista: "2026-10-06",
      method: "pix",
      userId: 1,
    });
    assert.equal(erro, null);

    conferir(await doisFormatos(r), { adiantamento: 4000, saldo: 6000, total: 10000 });
  });

  it("adiantamento cancelado deixa de valer: adiantamento zero e saldo total", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);
    const row = await entryDaReserva(r);
    assert.equal(await cancelarAdiantamentoAgendado(row.id), true);

    conferir(await doisFormatos(r), { adiantamento: 0, saldo: 10000, total: 10000 });
  });

  it("apos cancelar, um novo adiantamento combinado volta a valer", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);
    const primeira = await entryDaReserva(r);
    await cancelarAdiantamentoAgendado(primeira.id);
    await adiantamentoAgendado(r, 2500);

    conferir(await doisFormatos(r), { adiantamento: 2500, saldo: 7500, total: 10000 });
  });
});

/* ------------------------------------------------------------------ */
/* 8. Modelos formatados (HTML) nos dois formatos de contrato          */
/* ------------------------------------------------------------------ */

describe("modelo em HTML", () => {
  beforeEach(cenario);

  it("as duas variaveis tambem sao trocadas no modelo formatado", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);
    await definirModelos(MODELO_HTML);

    conferir(await doisFormatos(r), { adiantamento: 3000, saldo: 7000, total: 10000 });
  });

  it("modelos diferentes por formato recebem as mesmas variaveis", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);
    await definirModelos(`PAPEL {{adiantamento_valor}} {{valor_saldo}}`, `<p>DIGITAL {{adiantamento_valor}} {{valor_saldo}}</p>`);

    const { papel, digital } = await doisFormatos(r);
    assert.ok(papel.includes(`PAPEL ${money(3000)} ${money(7000)}`), `papel "${papel}"`);
    assert.ok(digital.includes(`DIGITAL ${money(3000)} ${money(7000)}`), `digital "${digital}"`);
    assert.ok(!papel.includes("DIGITAL") && !digital.includes("PAPEL"));
  });
});

/* ------------------------------------------------------------------ */
/* 9. Demais variaveis preservadas                                     */
/* ------------------------------------------------------------------ */

describe("demais variaveis permanecem como estavam", () => {
  beforeEach(cenario);

  it("{{valor_total}} continua sendo o total contratado, mesmo com tudo pago", async () => {
    const r = await reserva(10000);
    await adiantamentoPagoNoAto(r, 10000);

    conferir(await doisFormatos(r), { adiantamento: 10000, saldo: 0, total: 10000 });
  });

  it("{{saldo}} NAO foi reaproveitada no contrato: continua saindo vazia", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);
    await definirModelos(`WA: {{saldo}} | C: {{valor_saldo}}`);

    const { papel, digital } = await doisFormatos(r);
    // comportamento anterior: {{saldo}} nao e variavel de contrato e sai vazia
    assert.ok(papel.includes(`WA:  | C: ${money(7000)}`), `papel "${papel}"`);
    assert.ok(digital.includes(`WA:  | C: ${money(7000)}`), `digital "${digital}"`);
  });

  it("{{saldo}} do WhatsApp continua sendo o saldo FINANCEIRO pendente", async () => {
    const saldoFinanceiro = 7000; // total 100.00 - 30.00 ja recebidos
    const msgs = await messagesForReservation(
      {
        number: "LIMA-001",
        customer_name: "Joao da Silva",
        customer_phone: "11999990000",
        customer_whatsapp: "",
        event_date: "2026-10-10",
        delivery_at: null,
        pickup_at: null,
        address: null,
        district: null,
        city: null,
        total_cents: 10000,
      },
      "",
      saldoFinanceiro,
    );
    const cobranca = msgs.find((m) => m.key === "payment");
    assert.ok(cobranca, "mensagem de cobranca existe");
    assert.ok(cobranca.text.includes(money(saldoFinanceiro)), `saldo financeiro em "${cobranca.text}"`);
    assert.ok(!cobranca.text.includes("{{"));
  });

  it("modelo padrao do sistema continua gerando sem marcador sobrando", async () => {
    const r = await reserva(50000);
    await adiantamentoAgendado(r, 15000);
    await definirModelos(DEFAULT_SETTINGS.contract_template);

    const { papel, digital } = await doisFormatos(r);
    for (const corpo of [papel, digital]) {
      assert.ok(corpo.includes("TERMO DE RESPONSABILIDADE E CONTRATO DE LOCACAO"), "modelo padrao intacto");
      assert.ok(!corpo.includes("{{"), "nenhuma variavel do modelo padrao sobrou");
    }
    // o modelo padrao nao usa as variaveis novas: o texto dele nao muda
    assert.ok(!papel.includes(money(15000)), "modelo padrao permanece identico ao de sempre");
  });
});

/* ------------------------------------------------------------------ */
/* 10. Formatacao monetaria e isolamento                               */
/* ------------------------------------------------------------------ */

describe("formatacao monetaria e isolamento", () => {
  beforeEach(cenario);

  it("usa o padrao monetario brasileiro (R$ 30,00) nos dois formatos", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);

    const { papel, digital } = await doisFormatos(r);
    for (const corpo of [papel, digital]) {
      assert.match(corpo, /R\$\s?30,00/, "adiantamento no formato brasileiro");
      assert.match(corpo, /R\$\s?70,00/, "saldo no formato brasileiro");
      assert.match(corpo, /R\$\s?100,00/, "total no formato brasileiro");
      assert.ok(!/, ?\d{3}\.\d{3}/.test(corpo), "sem formato en-US");
    }
    assert.match(money(0), /^R\$\s?0,00$/, "zero tambem sai formatado");
    assert.match(money(123456), /^R\$\s?1\.234,56$/, "centavos e separador brasileiros");
  });

  it("sem adiantamento previsto, a variavel sai como R$ 0,00 e nunca em branco", async () => {
    const r = await reserva(10000);
    await definirModelos(`Adiantamento: [{{adiantamento_valor}}] Saldo: [{{valor_saldo}}]`);

    const { papel, digital } = await doisFormatos(r);
    for (const corpo of [papel, digital]) {
      assert.ok(corpo.includes(`Adiantamento: [${money(0)}]`), `zero formatado em "${corpo}"`);
      assert.ok(corpo.includes(`Saldo: [${money(10000)}]`));
    }
  });

  it("nao enxerga o adiantamento de outra empresa", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);

    assert.equal(await adiantamentoPrevisto(r, 1), 3000, "dono da reserva enxerga");
    assert.equal(await adiantamentoPrevisto(r, 2), 0, "outra empresa nao enxerga nada");
  });

  it("reserva de outra empresa nao gera contrato", async () => {
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 3000);
    await assert.rejects(() => buildContractBodyDigital(r, "CTR-009", 2), /Reserva não encontrada/);
  });
});

/* ------------------------------------------------------------------ */
/* Percentual de adiantamento da empresa (fallback contratual)         */
/* ------------------------------------------------------------------ */

describe("percentual de adiantamento previsto da empresa", () => {
  beforeEach(cenario);

  it("sem adiantamento registrado, vale o percentual configurado (30% de R$ 100,00)", async () => {
    await setSettings({ advance_percent: "30" });
    const r = await reserva(10000);

    conferir(await doisFormatos(r), { adiantamento: 3000, saldo: 7000, total: 10000 });
    assert.equal(await percentualAdiantamento(1), 30);
  });

  it("percentuais diferentes de 30% (25% e 50%)", async () => {
    await setSettings({ advance_percent: "25" });
    conferir(await doisFormatos(await reserva(10000)), { adiantamento: 2500, saldo: 7500, total: 10000 });

    await setSettings({ advance_percent: "50" });
    conferir(await doisFormatos(await reserva(10000)), { adiantamento: 5000, saldo: 5000, total: 10000 });
  });

  it("percentual com decimal (12,5% de R$ 80,00 = R$ 10,00)", async () => {
    await setSettings({ advance_percent: "12.5" });
    conferir(await doisFormatos(await reserva(8000)), { adiantamento: 1000, saldo: 7000, total: 8000 });
  });

  it("adiantamento registrado na reserva prevalece sobre o percentual", async () => {
    await setSettings({ advance_percent: "30" });
    const r = await reserva(10000);
    await adiantamentoAgendado(r, 2500);

    conferir(await doisFormatos(r), { adiantamento: 2500, saldo: 7500, total: 10000 });
  });

  it("adiantamento pago no ato tambem vence o percentual", async () => {
    await setSettings({ advance_percent: "30" });
    const r = await reserva(10000);
    await adiantamentoPagoNoAto(r, 4000);

    conferir(await doisFormatos(r), { adiantamento: 4000, saldo: 6000, total: 10000 });
  });

  it("pagamentos continuam sem efeito sobre as variaveis com o percentual ativo", async () => {
    await setSettings({ advance_percent: "30" });
    const r = await reserva(10000);
    await pagamentoComum(r, 5000, "entrada");

    conferir(await doisFormatos(r), { adiantamento: 3000, saldo: 7000, total: 10000 });
    const m = await reservationMoney(r);
    assert.equal(m.paid, 5000, "o caixa continua refletindo o pago");
    assert.equal(m.balance, 5000);
  });

  it("total quitado antecipadamente nao muda adiantamento nem saldo contratual", async () => {
    await setSettings({ advance_percent: "30" });
    const r = await reserva(10000);
    await pagamentoComum(r, 10000, "quitacao total");

    conferir(await doisFormatos(r), { adiantamento: 3000, saldo: 7000, total: 10000 });
    const m = await reservationMoney(r);
    assert.equal(m.paid, 10000);
    assert.equal(m.balance, 0, "saldo financeiro pendente zera; o contratual nao");
  });

  it("percentual vazio, zero ou invalido mantem adiantamento zerado", async () => {
    for (const valor of ["", "0", "abc"]) {
      await setSettings({ advance_percent: valor });
      const r = await reserva(10000);
      conferir(await doisFormatos(r), { adiantamento: 0, saldo: 10000, total: 10000 });
    }
    assert.equal(await percentualAdiantamento(1), 0);
  });

  it("{{adiantamento_percentual}} sai como 30% e some quando nao ha percentual", async () => {
    const modelo = "Pct: [{{adiantamento_percentual}}] AD: {{adiantamento_valor}} S: {{valor_saldo}}";

    await setSettings({ advance_percent: "30", contract_template: modelo, contract_template_digital: modelo });
    const r = await reserva(10000);
    let { papel, digital } = await doisFormatos(r);
    assert.ok(papel.includes(`Pct: [30%] AD: ${money(3000)} S: ${money(7000)}`), `papel "${papel}"`);
    assert.ok(digital.includes(`Pct: [30%] AD: ${money(3000)} S: ${money(7000)}`), `digital "${digital}"`);

    await setSettings({ advance_percent: "", contract_template: modelo, contract_template_digital: modelo });
    ({ papel, digital } = await doisFormatos(r));
    for (const corpo of [papel, digital]) {
      assert.ok(corpo.includes(`Pct: [] AD: ${money(0)} S: ${money(10000)}`), `sem percentual: "${corpo}"`);
      assert.ok(!corpo.includes("0%"), "sem percentual configurado nao aparece 0%");
      assert.ok(!corpo.includes("{{"));
    }
  });

  it("percentual e da empresa certa (isolamento por tenant)", async () => {
    await setSettings({ advance_percent: "30" });
    const r = await reserva(10000);

    assert.equal(await percentualAdiantamento(1), 30, "empresa dona enxerga o percentual");
    assert.equal(await percentualAdiantamento(2), 0, "outra empresa nao herda o percentual");
    assert.equal(await adiantamentoPrevisto(r, 2), 0, "nem o adiantamento calculado com ele");
  });
});
