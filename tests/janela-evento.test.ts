/**
 * PREENCHIMENTO AUTOMÁTICO DA JANELA ENTREGA/RETIRADA (item 2).
 *
 * Função pura, sem banco nem Next: entrega na data do evento, retirada D+1 e
 * horário do evento valendo para os dois quando definido. Também garante que
 * a automação NÃO sobrescreve edições manuais nem dados já salvos ao apenas
 * abrir a tela de edição. A aritmética é de calendário (addDays), então o
 * resultado não depende do fuso do host (os testes rodam em TZ=UTC).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sugerirJanelaEvento } from "../src/lib/availability-time.ts";

/** Fallbacks dos formulários: reserva usa retirada 10:00, orçamento 18:00. */
const RESERVA = { fallbackEntrega: "08:00", fallbackRetirada: "10:00" };
const ORCAMENTO = { fallbackEntrega: "08:00", fallbackRetirada: "18:00" };

function sugere(params: Partial<Parameters<typeof sugerirJanelaEvento>[0]>) {
  return sugerirJanelaEvento({
    eventDate: "",
    eventTime: "",
    deliveryAtual: "",
    pickupAtual: "",
    eventoMudou: true,
    ...RESERVA,
    ...params,
  });
}

describe("sugerirJanelaEvento — criação", () => {
  it("entrega na data do evento e retirada D+1, com o horário do evento nos dois", () => {
    const j = sugere({ eventDate: "2026-10-10", eventTime: "18:00" });
    assert.equal(j.deliveryAt, "2026-10-10T18:00");
    assert.equal(j.pickupAt, "2026-10-11T18:00");
  });

  it("sem horário no evento, usa os fallbacks do formulário (reserva 08:00/10:00)", () => {
    const j = sugere({ eventDate: "2026-10-10" });
    assert.equal(j.deliveryAt, "2026-10-10T08:00");
    assert.equal(j.pickupAt, "2026-10-11T10:00");
  });

  it("sem horário no evento, usa os fallbacks do formulário (orçamento 08:00/18:00)", () => {
    const j = sugere({ eventDate: "2026-10-10", ...ORCAMENTO });
    assert.equal(j.deliveryAt, "2026-10-10T08:00");
    assert.equal(j.pickupAt, "2026-10-11T18:00");
  });

  it("sem data de evento não mexe em nada", () => {
    const j = sugere({ eventDate: "", deliveryAtual: "2026-01-01T09:00", pickupAtual: "2026-01-02T09:00" });
    assert.equal(j.deliveryAt, "2026-01-01T09:00");
    assert.equal(j.pickupAt, "2026-01-02T09:00");
  });
});

describe("sugerirJanelaEvento — calendário/fuso", () => {
  it("virada de mês e de ano: 31/12 vira 01/01", () => {
    const j = sugere({ eventDate: "2026-12-31", eventTime: "18:00" });
    assert.equal(j.deliveryAt, "2026-12-31T18:00");
    assert.equal(j.pickupAt, "2027-01-01T18:00");
  });

  it("ano bissexto: 28/02 vira 29/02", () => {
    const j = sugere({ eventDate: "2028-02-28", eventTime: "09:00" });
    assert.equal(j.pickupAt, "2028-02-29T09:00");
  });

  it("mês cheio: 31/01 vira 01/02", () => {
    const j = sugere({ eventDate: "2027-01-31", eventTime: "12:00" });
    assert.equal(j.pickupAt, "2027-02-01T12:00");
  });
});

describe("sugerirJanelaEvento — edições manuais não são sobrescritas", () => {
  it("alterar a entrega manualmente não volta a ser mexida pela automação", () => {
    const j = sugere({
      eventDate: "2026-10-10",
      eventTime: "18:00",
      deliveryAtual: "2026-10-10T15:00", // usuário digitou 15:00
      deliveryManual: true,
    });
    assert.equal(j.deliveryAt, "2026-10-10T15:00");
    assert.equal(j.pickupAt, "2026-10-11T18:00");
  });

  it("exemplo do usuário: mudar a retirada para D+2 às 10:00 fica estável", () => {
    const j = sugere({
      eventDate: "2026-10-10",
      eventTime: "18:00",
      pickupAtual: "2026-10-12T10:00",
      pickupManual: true,
    });
    assert.equal(j.pickupAt, "2026-10-12T10:00");
    assert.equal(j.deliveryAt, "2026-10-10T18:00");
  });

  it("mudar o evento depois da edição manual atualiza só o campo não tocado", () => {
    const j = sugere({
      eventDate: "2026-11-01",
      eventTime: "18:00",
      deliveryAtual: "2026-10-10T18:00",
      pickupAtual: "2026-10-12T10:00", // editado à mão no evento anterior
      pickupManual: true,
      eventoMudou: true,
    });
    assert.equal(j.deliveryAt, "2026-11-01T18:00");
    assert.equal(j.pickupAt, "2026-10-12T10:00");
  });

  it("horário digitado manualmente é preservado ao mudar o evento", () => {
    const j = sugere({
      eventDate: "2026-11-01",
      eventTime: "20:00",
      deliveryAtual: "2026-10-10T15:00",
      deliveryManual: true,
      pickupManual: true,
      pickupAtual: "2026-10-11T15:00",
    });
    assert.equal(j.deliveryAt, "2026-10-10T15:00");
    assert.equal(j.pickupAt, "2026-10-11T15:00");
  });
});

describe("sugerirJanelaEvento — edição de registro já salvo", () => {
  it("abrir a tela sem mudar o evento não altera nada", () => {
    const j = sugere({
      eventDate: "2026-09-05",
      eventTime: "14:00",
      deliveryAtual: "2026-09-05T09:30", // valores salvos, fora do padrão
      pickupAtual: "2026-09-07T09:30",
      eventoMudou: false,
    });
    assert.equal(j.deliveryAt, "2026-09-05T09:30");
    assert.equal(j.pickupAt, "2026-09-07T09:30");
  });

  it("mudar o evento na edição repreenche os campos que não foram tocados", () => {
    const j = sugere({
      eventDate: "2026-09-20",
      eventTime: "14:00",
      deliveryAtual: "2026-09-05T09:30",
      pickupAtual: "2026-09-07T09:30",
      eventoMudou: true,
    });
    assert.equal(j.deliveryAt, "2026-09-20T14:00");
    assert.equal(j.pickupAt, "2026-09-21T14:00");
  });

  it("campo vazio é preenchido mesmo sem o evento ter mudado", () => {
    const j = sugere({
      eventDate: "2026-09-05",
      deliveryAtual: "",
      pickupAtual: "",
      eventoMudou: false,
    });
    assert.equal(j.deliveryAt, "2026-09-05T08:00");
    assert.equal(j.pickupAt, "2026-09-06T10:00");
  });
});
