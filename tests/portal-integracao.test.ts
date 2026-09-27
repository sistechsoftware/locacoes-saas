/**
 * Portal do Cliente, com o SQL real: autenticacao (convite, primeiro acesso,
 * login, sessao), isolamento entre clientes (IDOR) e as leituras do portal
 * batendo com a fonte unica da fidelidade.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { insert, run, one, scalar } from "../src/lib/db.ts";
import {
  cpfValido,
  gerarConviteAcesso,
  configurarAcesso,
  tentarLogin,
  loginCliente,
  abrirSessaoCliente,
  clienteDaSessao,
  apagarSessao,
  origemDaRequisicao,
} from "../src/lib/portal-core.ts";
import {
  financeiroDoCliente,
  reservasDoCliente,
  contratosDoCliente,
  proximaReserva,
  ultimaLocacao,
} from "../src/lib/portal.ts";
import { painelDoCliente, pontosDe, recompensasDisponiveis } from "../src/lib/fidelidade-db.ts";
import { aoConcluirLocacao, usarRecompensa } from "../src/lib/fidelidade-db.ts";

let clienteId = 0;
let mariaId = 0;
let KIT = 0;
let seq = 0;

/** CPFs de teste, digitos verificadores corretos. */
const CPF_A = "11144477735"; // valido
const CPF_B = "52998224725"; // valido
const FONE_A = "11999990001";
const FONE_B = "11999990002";

async function cenario() {
  createTestDb();
  seq = 0;
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
  KIT = await insert(
    `INSERT INTO products (code, name, kind, total_qty, rent_price_cents) VALUES ('KIT','Kit Festas','kit',0,2000)`,
  );
  clienteId = await insert(
    `INSERT INTO customers (name, doc, phone, whatsapp) VALUES ('Joao da Silva', '111.444.777-35', ?, ?)`,
    [FONE_A, FONE_A],
  );
  mariaId = await insert(
    `INSERT INTO customers (name, doc, phone, whatsapp) VALUES ('Maria Souza', '529.982.247-25', ?, ?)`,
    [FONE_B, FONE_B],
  );
}

async function novoClienteComAcesso(cpf = CPF_A, fone = FONE_A) {
  const id = await insert(
    `INSERT INTO customers (name, doc, phone, whatsapp) VALUES ('Cliente Teste', ?, ?, ?)`,
    [cpf, fone, fone],
  );
  await ativarAcesso(id, cpf, fone);
  return id;
}

/** Percorre o caminho real: convite -> primeiro acesso. */
async function ativarAcesso(customerId: number, cpf: string, fone: string) {
  const convite = await gerarConviteAcesso(customerId);
  assert.ok(convite, "convite gerado");
  const r = await configurarAcesso({ token: convite!.token, cpf, telefone: fone, password: "senhaforte123" });
  assert.ok(r.ok, "primeiro acesso concluido");
}

/** Cria uma locacao e leva ao status pedido, passando pelo gatilho real. */
async function locacao(
  customerId: number,
  status = "finalizada",
  total = 50000,
  dataEvento = "2026-09-20",
): Promise<number> {
  seq++;
  const id = await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, total_cents)
     VALUES (?,?,?,?,?)`,
    [`LIMA-${String(seq).padStart(3, "0")}`, customerId, status, dataEvento, total],
  );
  if (status === "finalizada" || status === "retirada") await aoConcluirLocacao(id);
  return id;
}

describe("origem do portal a partir da requisicao", () => {
  const h = (pares: Record<string, string>) => new Headers(pares);

  it("usa x-forwarded-host do proxy e o protocolo encaminhado", () => {
    assert.equal(
      origemDaRequisicao(h({ "x-forwarded-host": "limas-locacoes.limas-locacoes.workers.dev", "x-forwarded-proto": "https" })),
      "https://limas-locacoes.limas-locacoes.workers.dev",
    );
  });

  it("cai para host quando nao ha proxy, e https fora de localhost", () => {
    assert.equal(origemDaRequisicao(h({ host: "meudominio.com.br" })), "https://meudominio.com.br");
  });

  it("localhost roda em http", () => {
    assert.equal(origemDaRequisicao(h({ host: "localhost:3210" })), "http://localhost:3210");
    assert.equal(origemDaRequisicao(h({ host: "127.0.0.1:8787" })), "http://127.0.0.1:8787");
  });

  it("host malformado devolve vazio: o link degrada, nao quebra", () => {
    assert.equal(origemDaRequisicao(h({ host: "host ruim com espaco" })), "");
    assert.equal(origemDaRequisicao(new Headers()), "");
  });
});

describe("cpf", () => {
  it("aceita CPF valido e recusa invalido", () => {
    assert.ok(cpfValido(CPF_A));
    assert.ok(cpfValido("111.444.777-35"));
    assert.ok(!cpfValido("11111111111"));
    assert.ok(!cpfValido("12345678901"));
    assert.ok(!cpfValido("1114447773"));
    assert.ok(!cpfValido(""));
  });
});

describe("primeiro acesso", () => {
  beforeEach(cenario);

  it("convite + cpf + telefone criam a senha e queimam o token", async () => {
    await ativarAcesso(clienteId, CPF_A, FONE_A); // fluxo real: convite -> setup
    const acesso = await one<any>(`SELECT portal_password_hash FROM customers WHERE id = ?`, [clienteId]);
    assert.ok(acesso?.portal_password_hash, "senha gravada");
    const c = await one<any>(`SELECT portal_setup_token_hash FROM customers WHERE id = ?`, [clienteId]);
    assert.equal(c.portal_setup_token_hash, null, "token queimado");
  });

  it("telefone errado nao configura a conta", async () => {
    const convite = await gerarConviteAcesso(mariaId);
    const r = await configurarAcesso({
      token: convite!.token,
      cpf: CPF_B,
      telefone: "11999990099",
      password: "senhaforte123",
    });
    assert.ok(!r.ok);
    const c = await one<any>(`SELECT portal_password_hash FROM customers WHERE id = ?`, [mariaId]);
    assert.equal(c.portal_password_hash, null, "sem senha gravada");
  });

  it("cpf de outro cliente nao configura a conta", async () => {
    const convite = await gerarConviteAcesso(clienteId);
    const r = await configurarAcesso({
      token: convite!.token,
      cpf: CPF_B, // Maria
      telefone: FONE_A, // do Joao
      password: "senhaforte123",
    });
    assert.ok(!r.ok);
  });

  it("token reutilizado e recusado", async () => {
    const convite = await gerarConviteAcesso(clienteId);
    await configurarAcesso({ token: convite!.token, cpf: CPF_A, telefone: FONE_A, password: "senhaforte123" });
    const segunda = await configurarAcesso({
      token: convite!.token,
      cpf: CPF_A,
      telefone: FONE_A,
      password: "outrasenha456",
    });
    assert.ok(!segunda.ok, "o token nao pode ser usado duas vezes");
  });

  it("senha curta, cpf invalido e telefone ausente viram erro", async () => {
    const convite = await gerarConviteAcesso(mariaId);
    assert.ok(!(await configurarAcesso({ token: convite!.token, cpf: CPF_B, telefone: FONE_B, password: "curta" })).ok);
    assert.ok(!(await configurarAcesso({ token: convite!.token, cpf: "123", telefone: FONE_B, password: "senhaforte123" })).ok);
    assert.ok(!(await configurarAcesso({ token: convite!.token, cpf: CPF_B, telefone: "", password: "senhaforte123" })).ok);
  });

  it("gerar novo convite revoga o anterior", async () => {
    const primeiro = await gerarConviteAcesso(mariaId);
    const segundo = await gerarConviteAcesso(mariaId);
    const r1 = await configurarAcesso({ token: primeiro!.token, cpf: CPF_B, telefone: FONE_B, password: "senhaforte123" });
    assert.ok(!r1.ok, "o primeiro convite nao vale mais");
    const r2 = await configurarAcesso({ token: segundo!.token, cpf: CPF_B, telefone: FONE_B, password: "senhaforte123" });
    assert.ok(r2.ok);
  });
});

describe("login e sessao", () => {
  beforeEach(cenario);

  it("senha certa autentica, errada nao", async () => {
    await ativarAcesso(clienteId, CPF_A, FONE_A); // precisa da conta ativa
    const ok = await tentarLogin(CPF_A, "senhaforte123");
    assert.equal(ok.erro, null);
    assert.equal(ok.customerId, clienteId);

    const falha = await tentarLogin(CPF_A, "senhaerrada999");
    assert.match(falha.erro ?? "", /inválidos/i);
    assert.equal(falha.customerId, null, "login falho nao devolve cliente");
  });

  it("sessao: abre, carrega o dono e encerra", async () => {
    const sessionId = await abrirSessaoCliente(clienteId);
    const dono = await clienteDaSessao(sessionId);
    assert.equal(dono?.id, clienteId);
    assert.equal(dono?.name, "Joao da Silva");
    await apagarSessao(sessionId);
    assert.equal(await clienteDaSessao(sessionId), null, "sessao encerrada nao carrega ninguem");
  });

  it("id de sessao invalido nao carrega ninguem", async () => {
    assert.equal(await clienteDaSessao("nao-e-hex-64"), null);
    assert.equal(await clienteDaSessao(""), null);
  });

  it("cliente sem portal cai no mesmo erro de senha errada", async () => {
    await insert(`INSERT INTO customers (name, doc, phone) VALUES ('Sem Portal', '39053344705', '11999990009')`);
    const erro = await loginCliente("39053344705", "qualquersenha");
    assert.match(erro ?? "", /inválidos/i);
    assert.equal(await clienteDaSessao("0".repeat(64)), null);
  });

  it("cpf invalido e recusado antes de consultar", async () => {
    const erro = await loginCliente("11111111111", "senhaforte123");
    assert.match(erro ?? "", /inválidos/i);
  });
});

describe("leitura de dados do portal", () => {
  beforeEach(cenario);

  it("cliente sem locacoes ve estado inicial 0/5 e nada quebrado", async () => {
    const p = await painelDoCliente(clienteId);
    assert.equal(p.progresso.noCiclo, 0);
    assert.equal(p.progresso.faltam, 5);
    assert.deepEqual(p.recompensas, []);
    const f = await financeiroDoCliente(clienteId);
    assert.equal(f.total_cents, 0);
    assert.equal(f.locacoes_concluidas, 0);
    assert.equal(await proximaReserva(clienteId), undefined, "sem reserva futura: sem erro");
    assert.equal(await ultimaLocacao(clienteId), undefined);
    assert.deepEqual(await reservasDoCliente(clienteId), []);
    assert.deepEqual(await contratosDoCliente(clienteId), []);
  });

  it("progresso 1..4 sem recompensa", async () => {
    for (let i = 1; i <= 4; i++) {
      await locacao(clienteId);
      const p = await painelDoCliente(clienteId);
      assert.equal(p.progresso.noCiclo, i);
    }
    assert.deepEqual(await recompensasDisponiveis(clienteId), []);
  });

  it("5 locacoes liberam a recompensa de ate 5 kits", async () => {
    for (let i = 0; i < 5; i++) await locacao(clienteId);
    const p = await painelDoCliente(clienteId);
    assert.equal(p.recompensas.length, 1);
    assert.equal(p.recompensas[0].kit_quantity, 5);
    assert.equal(p.recompensas[0].situacao, "disponivel");
    assert.equal(p.progresso.faltam, 0);
  });

  it("recompensa usada inicia novo ciclo", async () => {
    for (let i = 0; i < 5; i++) await locacao(clienteId);
    const [r] = await recompensasDisponiveis(clienteId);
    seq++;
    const nova = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, total_cents)
       VALUES (?,?,?,?,'0')`,
      [`LIMA-${String(seq).padStart(3, "0")}`, clienteId, "confirmada", "2026-10-10"],
    );
    await insert(
      `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents, subtotal_cents)
       VALUES (?,?,3,2000,6000)`,
      [nova, KIT],
    );
    assert.equal(await usarRecompensa(r.id, nova, 1), null);
    const p = await painelDoCliente(clienteId);
    assert.equal(p.progresso.noCiclo, 0, "novo ciclo");
    assert.equal(p.recompensas.find((x: any) => x.id === r.id).situacao, "usada");
  });

  it("varias recompensas mantem o historico correto", async () => {
    for (let i = 0; i < 10; i++) await locacao(clienteId);
    const p = await painelDoCliente(clienteId);
    assert.equal(p.recompensas.length, 2);
    assert.equal(p.progresso.ciclosCompletos, 2);
  });

  it("cancelada nao pontua e nao aparece como contou no fidelidade", async () => {
    await locacao(clienteId, "cancelada", 50000);
    assert.equal(await pontosDe(clienteId), 0);
    const rs = await reservasDoCliente(clienteId);
    assert.equal(rs[0].contou_fidelidade, false);
    assert.equal(rs[0].usou_recompensa, false);
  });

  it("reservas do portal carregam as marcas de fidelidade certas", async () => {
    await locacao(clienteId);
    await locacao(clienteId, "confirmada", 50000, "2026-12-20");
    const rs = await reservasDoCliente(clienteId);
    const concluida = rs.find((r) => r.status === "finalizada");
    const futura = rs.find((r) => r.status === "confirmada");
    assert.equal(concluida!.contou_fidelidade, true);
    assert.equal(futura!.contou_fidelidade, false);
    const prox = await proximaReserva(clienteId);
    assert.equal(prox?.id, futura!.id);
  });

  it("financeiro do portal bate com o que o sistema interno ve", async () => {
    await locacao(clienteId, "finalizada", 40000);
    await locacao(clienteId, "finalizada", 60000);
    await insert(`INSERT INTO payments (reservation_id, amount_cents, method, paid_at) VALUES (?,30000,'pix','2026-09-21')`, [1]);
    const f = await financeiroDoCliente(clienteId);
    assert.equal(f.total_cents, 100000);
    assert.equal(f.pago_cents, 30000);
    assert.equal(f.saldo_cents, 70000);
    assert.equal(f.locacoes_concluidas, 2);
    // o indicador interno usa a mesma conta: nao pode divergir
    const interno = await one<any>(
      `SELECT COALESCE(SUM(total_cents),0) AS total FROM reservations
        WHERE customer_id = ? AND status IN ('pre_reserva','confirmada','entregue','em_uso','aguardando_retirada','retirada','finalizada')`,
      [clienteId],
    );
    assert.equal(f.total_cents, interno.total);
  });

  it("financeiro isola clientes", async () => {
    await locacao(clienteId, "finalizada", 40000);
    const fMaria = await financeiroDoCliente(mariaId);
    assert.equal(fMaria.total_cents, 0);
    const rMaria = await reservasDoCliente(mariaId);
    assert.equal(rMaria.length, 0);
  });
});

describe("isolamento entre clientes (IDOR)", () => {
  beforeEach(cenario);

  it("reserva de outro cliente nao e encontrada pela leitura do portal", async () => {
    const reservaDoJoao = await locacao(clienteId, "finalizada", 30000);
    const maria = await reservasDoCliente(mariaId);
    assert.equal(maria.length, 0, "Maria nao ve nada do Joao");
    // a funcao de detalhe recebe (sessao, id): sessao da Maria + id do Joao
    const { reservaDoCliente } = await import("../src/lib/portal.ts");
    assert.equal(await reservaDoCliente(mariaId, reservaDoJoao), null);
  });

  it("recompensa disponivel pertence so ao dono", async () => {
    for (let i = 0; i < 5; i++) await locacao(clienteId);
    const doJoao = await recompensasDisponiveis(clienteId);
    assert.equal(doJoao.length, 1);
    assert.equal((await recompensasDisponiveis(mariaId)).length, 0);
  });

  it("proximo numero de locacao nao vaza entre clientes", async () => {
    await locacao(clienteId, "finalizada");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM reservations WHERE customer_id = ?`, [mariaId]), 0);
  });
});
