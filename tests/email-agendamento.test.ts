/**
 * Agendador de e-mails: captura de lembretes e cancelamento, com o SQL real.
 *
 * Cobre o caminho do cron (paraCadaEmpresa -> runEmailScheduler) para DUAS
 * empresas no mesmo banco:
 *  - lembrete capturado na janela do gatilho, com a antecedência configurada
 *    (3 dias e 1 dia), sem intervalo fixo em código;
 *  - reexecução do cron não duplica (dedupe_key determinística);
 *  - reserva cancelada/orçamento/pré-reserva não gera lembrete;
 *  - interruptor geral ou do tipo desligado não enfileira nada;
 *  - a janela de uma empresa nunca captura a reserva da outra;
 *  - mudar a data cancela o lembrete antigo e o da data nova é capturado;
 *  - lembrete de operação, saída e operação em atraso seguem a mesma regra;
 *  - fim a fim: captura + envio pelo sender falso, com o destinatário certo.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { insert, resetCompanyCache, run, runWithCompany, all, getDb, scalar } from "../src/lib/db.ts";
import { setSettings } from "../src/lib/settings.ts";
import { configEmailDaEmpresa } from "../src/lib/email-queue.ts";
import { runEmailScheduler, __internos } from "../src/lib/email-scheduler.ts";
import { reservaAlterada, reservaCancelada, operacaoStatus } from "../src/lib/email-gatilhos.ts";
import { epochDeWallClock, wallClockIso } from "../src/lib/email-tempo.ts";
import type { EmailMensagem, ResultadoEnvio } from "../src/lib/email.ts";

const FUSO = "America/Sao_Paulo";
const agora = () => Math.floor(Date.now() / 1000);
const DIAS = (n: number) => n * 86400;

let seq = 0;

const ENVIADO: ResultadoEnvio = { ok: true, id: "id-1", status: 200, temporaria: false, erro: null, motivoConfig: null };

/** Sender falso: registra as chamadas e devolve o resultado escolhido. */
function remetente(resultado: ResultadoEnvio = ENVIADO) {
  const chamadas: EmailMensagem[] = [];
  return {
    chamadas,
    fn: async (msg: EmailMensagem) => {
      chamadas.push(msg);
      return resultado;
    },
  };
}

beforeEach(async () => {
  createTestDb();
  resetCompanyCache();
  seq = 0;
  await run(`INSERT INTO companies (id, name, active) VALUES (2,'Zumbi Eventos',1)`);
  await setSettings({ company_name: "Festas Lima", email_enabled: "1", email_hora_envio: "00:00" }, 1);
  await setSettings({ company_name: "Zumbi Eventos", email_enabled: "1", email_hora_envio: "00:00" }, 2);
});
afterEach(() => {
  resetTestDb();
  resetCompanyCache();
});

async function novoCliente(companyId: number, nome = "Ana Souza", email: string | null = "ana@exemplo.com") {
  return await insert(`INSERT INTO customers (name, email, company_id) VALUES (?,?,?)`, [nome, email, companyId]);
}

/** Reserva cuja âncora (data + horário) é o texto informado, no fuso do negócio. */
async function novaReserva(companyId: number, customerId: number, status: string, ancoraIso: string) {
  seq += 1;
  const event_date = ancoraIso.slice(0, 10);
  const event_time = ancoraIso.slice(11, 16);
  return await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, event_time, delivery_at, pickup_at, company_id)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      `TEST-${companyId}-${seq}`,
      customerId,
      status,
      event_date,
      event_time,
      `${event_date}T08:00`,
      `${event_date}T18:00`,
      companyId,
    ],
  );
}

async function novaOperacao(companyId: number, reservationId: number, scheduledAt: string, status = "pendente") {
  return await insert(
    `INSERT INTO operations (kind, reservation_id, scheduled_at, status, company_id) VALUES ('entrega',?,?,?,?)`,
    [reservationId, scheduledAt, status, companyId],
  );
}

/** Só a captura (o que o cron faz antes de enviar) — devolve quantas linhas nasceram. */
async function capturar(companyId: number, now: number): Promise<number> {
  const cfg = await configEmailDaEmpresa(companyId);
  return (
    (await __internos.capturarLembretesReserva(getDb(), companyId, cfg, now)) +
    (await __internos.capturarLembretesOperacao(getDb(), companyId, cfg, now)) +
    (await __internos.capturarAtrasadas(getDb(), companyId, cfg, now))
  );
}

/** Roda o agendador COMPLETO como o cron roda: uma empresa por vez. */
async function rodar(companyId: number, now: number, sender = remetente().fn) {
  return await runWithCompany(companyId, () => runEmailScheduler(getDb(), now, sender));
}

type Linha = {
  id: number;
  type: string;
  status: string;
  motivo: string | null;
  recipient: string;
  subject: string;
  dedupe_key: string;
  context: string;
  scheduled_at: number;
};

const linhas = async (companyId: number, tipo?: string) =>
  await all<Linha>(
    `SELECT id, type, status, motivo, recipient, subject, dedupe_key, context, scheduled_at
       FROM email_notifications WHERE company_id = ? ${tipo ? "AND type = ?" : ""} ORDER BY id`,
    tipo ? [companyId, tipo] : [companyId],
  );

const total = async () => (await scalar<number>(`SELECT COUNT(*) FROM email_notifications`)) ?? 0;

describe("lembrete de reserva", () => {
  it("captura na janela do gatilho e agenda com a antecedência configurada", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    const reserva = await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));

    const n = await capturar(2, now);
    assert.equal(n, 1);

    const l = await linhas(2);
    assert.equal(l.length, 1);
    assert.equal(l[0].type, "reserva_lembrete");
    assert.equal(l[0].status, "pendente");
    assert.equal(l[0].recipient, "ana@exemplo.com");
    assert.ok(l[0].dedupe_key.startsWith("c2:reserva_lembrete:"), l[0].dedupe_key);
    assert.ok(l[0].dedupe_key.includes(String(reserva)));
    assert.deepEqual(JSON.parse(l[0].context), { reservation_id: reserva, antecedencia: 4320 });
    // com hora de envio às 00:00 não há adiamento: o gatilho vale como está
    // (o gatilho é derivado do relógio de parede da reserva, sem segundos)
    const gatilho = epochDeWallClock(wallClockIso(now + DIAS(3), FUSO), FUSO) - 4320 * 60;
    assert.equal(l[0].scheduled_at, gatilho);
  });

  it("reexecutar a captura no mesmo minuto não duplica", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));

    await capturar(2, now);
    await capturar(2, now);
    await capturar(2, now + 60);
    assert.equal((await linhas(2)).length, 1, "mesma situação virou duas linhas");
  });

  it("os dois lembretes configurados saem em seus próprios gatilhos", async () => {
    const now = agora();
    const cliente = await novoCliente(1);
    await novaReserva(1, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));

    await capturar(1, now); // 3 dias antes (4320 min)
    await capturar(1, now + DIAS(2)); // 1 dia antes (1440 min)
    await capturar(1, now + DIAS(2)); // de novo: não duplica

    const l = await linhas(1);
    assert.equal(l.length, 2);
    const offsets = l.map((x) => JSON.parse(x.context).antecedencia).sort((a, b) => b - a);
    assert.deepEqual(offsets, [4320, 1440]);
    assert.equal(new Set(l.map((x) => x.dedupe_key)).size, 2, "chaves de dedupe repetidas");
  });

  it("reserva cancelada, orçamento ou pré-reserva não geram lembrete", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    for (const status of ["cancelada", "orcamento", "pre_reserva"]) {
      await novaReserva(2, cliente, status, wallClockIso(now + DIAS(3), FUSO));
    }
    await capturar(2, now);
    assert.equal(await total(), 0, "status que não permitem lembrete entraram na fila");
  });

  it("reserva de demonstração fica de fora", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    const ancora = wallClockIso(now + DIAS(3), FUSO);
    await run(
      `INSERT INTO reservations (number, customer_id, status, event_date, event_time, company_id, is_demo)
       VALUES ('DEMO-1',?,'confirmada',?,?,?,1)`,
      [cliente, ancora.slice(0, 10), ancora.slice(11), 2],
    );
    await capturar(2, now);
    assert.equal(await total(), 0);
  });

  it("cliente sem e-mail vira registro ignorado, não envio", async () => {
    const now = agora();
    const cliente = await novoCliente(2, "Sem Email", null);
    await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));

    await capturar(2, now);
    const l = await linhas(2);
    assert.equal(l.length, 1);
    assert.equal(l[0].status, "ignorado");
    assert.equal(l[0].motivo, "sem_email");
    assert.equal(l[0].recipient, "");
  });
});

describe("interruptores por tenant", () => {
  it("master desligado não captura nada", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    await setSettings({ email_enabled: "0" }, 2);

    await capturar(2, now);
    assert.equal(await total(), 0);
  });

  it("tipo ou grupo desligado não captura", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));

    await setSettings({ email_reserva_lembrete: "0" }, 2);
    await capturar(2, now);
    assert.equal(await total(), 0, "lembrete desligado entrou na fila");

    await setSettings({ email_reserva_lembrete: "1", email_grupo_reservas: "0" }, 2);
    await capturar(2, now);
    assert.equal(await total(), 0, "grupo desligado não foi respeitado");
  });

  it("uma empresa desligada não impede a outra de capturar", async () => {
    const now = agora();
    const c1 = await novoCliente(1);
    const c2 = await novoCliente(2);
    await novaReserva(1, c1, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    await novaReserva(2, c2, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    await setSettings({ email_enabled: "0" }, 1);

    await capturar(2, now);

    const l2 = await linhas(2);
    assert.equal(l2.length, 1, "a empresa 2 deixou de capturar por causa da 1");
    assert.ok(l2[0].dedupe_key.startsWith("c2:"));
    assert.equal((await linhas(1)).length, 0, "empresa desligada recebeu linha");
  });

  it("a captura da empresa 1 nunca pega a reserva da empresa 2", async () => {
    const now = agora();
    const c1 = await novoCliente(1);
    const c2 = await novoCliente(2);
    await novaReserva(1, c1, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    await novaReserva(2, c2, "confirmada", wallClockIso(now + DIAS(3), FUSO));

    await capturar(1, now);
    const l1 = await linhas(1);
    assert.equal(l1.length, 1);
    assert.equal((await linhas(2)).length, 0, "a empresa 2 capturou estando fora do seu turno");
    assert.ok(l1[0].dedupe_key.startsWith("c1:"));
  });
});

describe("mudança de data e cancelamento", () => {
  it("alterar a data cancela o lembrete antigo e o da data nova é capturado", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    const antigaAncora = wallClockIso(now + DIAS(1), FUSO);
    const reservaId = await novaReserva(2, cliente, "confirmada", antigaAncora);

    await capturar(2, now);
    assert.equal((await linhas(2, "reserva_lembrete"))[0].status, "pendente");

    // o formulário salva a NOVA data e a action avisa a mudança
    const novaAncora = wallClockIso(now + DIAS(3), FUSO);
    const estado = {
      event_date: antigaAncora.slice(0, 10),
      event_time: antigaAncora.slice(11),
      delivery_at: `${antigaAncora.slice(0, 10)}T08:00`,
      pickup_at: `${antigaAncora.slice(0, 10)}T18:00`,
      status: "confirmada",
    };
    await reservaAlterada(
      2,
      reservaId,
      estado,
      {
        ...estado,
        event_date: novaAncora.slice(0, 10),
        event_time: novaAncora.slice(11),
        delivery_at: `${novaAncora.slice(0, 10)}T08:00`,
        pickup_at: `${novaAncora.slice(0, 10)}T18:00`,
      },
    );
    await run(`UPDATE reservations SET event_date = ?, event_time = ? WHERE id = ?`, [
      novaAncora.slice(0, 10),
      novaAncora.slice(11),
      reservaId,
    ]);

    const antigo = (await linhas(2, "reserva_lembrete"))[0];
    assert.equal(antigo.status, "cancelado", "lembrete da data antiga continuou válido");
    assert.equal(antigo.motivo, "lembrete_cancelado");
    assert.equal((await linhas(2, "reserva_alteracao")).length, 1, "faltou o aviso de alteração");

    // o gatilho da data nova ainda vai passar e gera OUTRA linha
    await capturar(2, now + DIAS(2));
    const novos = await linhas(2, "reserva_lembrete");
    assert.equal(novos.length, 2, "o lembrete da data nova não foi capturado");
    assert.equal(novos.filter((l) => l.status === "pendente").length, 1);
    assert.equal(novos.filter((l) => l.status === "cancelado").length, 1);
  });

  it("cancelar a reserva limpa a fila do futuro e registra o aviso", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    const reservaId = await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    await capturar(2, now);
    assert.equal((await linhas(2)).filter((l) => l.status === "pendente").length, 1);

    await run(`UPDATE reservations SET status = 'cancelada' WHERE id = ?`, [reservaId]);
    await reservaCancelada(2, reservaId);

    const l = await linhas(2);
    assert.equal(l.filter((x) => x.status === "pendente" && x.type === "reserva_lembrete").length, 0, "lembrete sobreviveu ao cancelamento");
    assert.ok(l.some((x) => x.type === "reserva_cancelamento" && x.status === "pendente"), "faltou o aviso de cancelamento");

    // depois do cancelamento nada mais é capturado
    await capturar(2, now + DIAS(3));
    assert.equal((await linhas(2, "reserva_lembrete")).filter((x) => x.status === "pendente").length, 0);
  });
});

describe("operações (entregas e retiradas)", () => {
  it("lembrete da operação é capturado pelo horário agendado", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    const reservaId = await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    const opId = await novaOperacao(2, reservaId, wallClockIso(now + DIAS(1), FUSO));

    await capturar(2, now);
    const l = await linhas(2, "operacao_lembrete");
    assert.equal(l.length, 1);
    assert.deepEqual(JSON.parse(l[0].context), { operation_id: opId, antecedencia: 1440 });
    assert.ok(l[0].dedupe_key.startsWith("c2:operacao_lembrete:"));
    assert.equal(l[0].recipient, "ana@exemplo.com");
  });

  it("operação concluída ou cancelada não gera lembrete", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    const reservaId = await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    await novaOperacao(2, reservaId, wallClockIso(now + DIAS(1), FUSO), "concluida");
    await novaOperacao(2, reservaId, wallClockIso(now + DIAS(1), FUSO), "cancelada");

    await capturar(2, now);
    const tipos = [...new Set((await linhas(2)).map((x) => x.type))].filter((t) => t !== "reserva_lembrete");
    assert.deepEqual(tipos, [], "operação concluída/cancelada gerou notificação de operação");
  });

  it("transição para Em rota registra o aviso de saída uma única vez", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    const reservaId = await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    const opId = await novaOperacao(2, reservaId, wallClockIso(now + DIAS(1), FUSO));

    await operacaoStatus(2, opId, "pendente", "em_rota", reservaId);
    await operacaoStatus(2, opId, "em_rota", "em_rota", reservaId); // repetição do mesmo status
    await capturar(2, now);

    const l = await linhas(2, "operacao_saida");
    assert.equal(l.length, 1, "status repetido gerou segundo e-mail");
    assert.equal(l[0].dedupe_key, `c2:operacao_saida:${opId}:em_rota`);
  });

  it("operação concluída registra o aviso de conclusão", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    const reservaId = await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    const opId = await novaOperacao(2, reservaId, wallClockIso(now + DIAS(1), FUSO));

    await operacaoStatus(2, opId, "confirmada", "concluida", reservaId);
    await operacaoStatus(2, opId, "concluida", "concluida", reservaId);

    const l = await linhas(2, "operacao_concluida");
    assert.equal(l.length, 1);
    assert.equal(l[0].dedupe_key, `c2:operacao_concluida:${opId}:concluida`);
  });

  it("operação atrasada gera um aviso por dia, sem virar spam por minuto", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    const reservaId = await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    await novaOperacao(2, reservaId, wallClockIso(now - DIAS(2), FUSO), "pendente");
    await setSettings({ email_operacao_atrasada: "1" }, 2);

    await capturar(2, now);
    await capturar(2, now + 60);
    await capturar(2, now + 120);

    const l = await linhas(2, "operacao_atrasada");
    assert.equal(l.length, 1);
    assert.ok(l[0].dedupe_key.startsWith("c2:operacao_atrasada:"));
  });
});

describe("hora de envio", () => {
  it("lembrete que cairia antes da hora configurada espera até ela", async () => {
    const hoje = wallClockIso(agora(), FUSO).slice(0, 10);
    const gatilho = epochDeWallClock(`${hoje}T06:00`, FUSO); // hoje às 06:00
    const cliente = await novoCliente(2);
    await setSettings({ email_hora_envio: "08:00" }, 2);
    // evento amanhã 06:00 => lembrete de 1440min vence hoje às 06:00
    const amanha = wallClockIso(gatilho + 1440 * 60, FUSO);
    await run(
      `INSERT INTO reservations (number, customer_id, status, event_date, event_time, company_id)
       VALUES ('HORA-1',?,'confirmada',?,?,?)`,
      [cliente, amanha.slice(0, 10), amanha.slice(11, 16), 2],
    );

    await capturar(2, gatilho);
    const l = await linhas(2);
    assert.equal(l.length, 1);
    assert.equal(l[0].status, "pendente");
    assert.ok(l[0].scheduled_at > gatilho, "o envio não foi adiado até a hora configurada");
    assert.equal(wallClockIso(l[0].scheduled_at, FUSO).slice(11, 16), "08:00");
    // e o cron SÓ envia quando o relógio chegar lá
    const r = await rodar(2, gatilho, remetente().fn);
    assert.equal(r.enviados, 0, "enviou antes da hora configurada");
    assert.equal((await linhas(2))[0].status, "pendente");
  });
});

describe("ponta a ponta (captura + envio)", () => {
  it("o cron captura e envia pelo provedor com destinatário e nome da locadora", async () => {
    const now = agora();
    const cliente = await novoCliente(2, "Carla Dias", "carla@exemplo.com");
    await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    const r = remetente();

    const saida = await rodar(2, now, r.fn);
    assert.equal(saida.capturados, 1);
    assert.equal(saida.enviados, 1);
    assert.equal(r.chamadas.length, 1);
    assert.equal(r.chamadas[0].to, "carla@exemplo.com");
    assert.equal(r.chamadas[0].deNome, "Zumbi Eventos", "o remetente não é a empresa dona da reserva");

    const l = await linhas(2);
    assert.equal(l[0].status, "enviado");
    assert.equal(l[0].subject, r.chamadas[0].subject);
    assert.ok(l[0].subject.includes("Zumbi Eventos"), l[0].subject);
  });

  it("a segunda execução não reenvia o que já foi aceito", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    const r = remetente();

    await rodar(2, now, r.fn);
    await rodar(2, now, r.fn);
    await rodar(2, now + 60, r.fn);

    assert.equal(r.chamadas.length, 1, "reexecução do cron reenviou o mesmo e-mail");
    assert.equal((await linhas(2)).filter((x) => x.status === "enviado").length, 1);
  });

  it("falha do provedor não derruba a captura das próximas rotinas", async () => {
    const now = agora();
    const cliente = await novoCliente(2);
    await novaReserva(2, cliente, "confirmada", wallClockIso(now + DIAS(3), FUSO));
    const ruim = remetente({ ok: false, id: null, status: 500, temporaria: true, erro: "HTTP 500", motivoConfig: null });

    const saida = await rodar(2, now, ruim.fn);
    assert.equal(saida.capturados, 1, "a falha de envio impediu a captura");
    assert.equal(saida.falhas, 1);
    const l = await linhas(2);
    assert.equal(l[0].status, "falha_temporaria");
    assert.equal(l[0].motivo, null);
    assert.ok(l[0].scheduled_at > 0);
  });
});
