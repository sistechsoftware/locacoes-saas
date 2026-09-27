/**
 * Aniversarios com o SQL real: consulta por dia e mes, rotina diaria,
 * deduplicacao do aviso e push sem atividade por tras.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { all, insert, one, run, scalar } from "../src/lib/db.ts";
import {
  aniversariantesDeHoje,
  aniversariantesDoMes,
  aniversariantesNaJanela,
  buscarAniversariantes,
  clientesSemData,
  resumoAniversarios,
  rotinaAniversarios,
} from "../src/lib/aniversarios-db.ts";

const HOJE = "2026-09-07";

async function cenario() {
  createTestDb();
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
}

async function cliente(nome: string, nascimento: string | null, telefone = "11999990000") {
  return await insert(`INSERT INTO customers (name, birth_date, phone, whatsapp) VALUES (?,?,?,?)`, [
    nome,
    nascimento,
    telefone,
    telefone,
  ]);
}

async function config(chave: string, valor: string) {
  await run(`INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, [
    chave,
    valor,
  ]);
}

describe("consulta de aniversariantes", () => {
  beforeEach(cenario);

  it("acha quem faz aniversario hoje", async () => {
    await cliente("Joao Ribeiro", "1990-09-07");
    await cliente("Maria Souza", "1985-09-20");
    const hoje = await aniversariantesDeHoje(HOJE);
    assert.equal(hoje.length, 1);
    assert.equal(hoje[0].name, "Joao Ribeiro");
    assert.equal(hoje[0].idadeQueCompleta, 36);
  });

  it("varias pessoas no mesmo dia aparecem todas", async () => {
    await cliente("Joao", "1990-09-07");
    await cliente("Ana", "1978-09-07");
    await cliente("Pedro", "2001-09-07");
    assert.equal((await aniversariantesDeHoje(HOJE)).length, 3);
  });

  it("a janela de sete dias pega amanha e o setimo dia", async () => {
    await cliente("Amanha", "1990-09-08");
    await cliente("Setimo", "1990-09-14");
    await cliente("Oitavo", "1990-09-15");
    const j = await aniversariantesNaJanela(7, HOJE);
    assert.deepEqual(j.map((a) => a.name), ["Amanha", "Setimo"]);
    assert.equal(j[0].dias, 1);
    assert.equal(j[1].dias, 7);
  });

  it("cliente sem data nunca aparece e nao quebra a consulta", async () => {
    await cliente("Sem data", null);
    await cliente("Vazio", "");
    await cliente("Com data", "1990-09-07");
    const hoje = await aniversariantesDeHoje(HOJE);
    assert.equal(hoje.length, 1);
    assert.equal(hoje[0].name, "Com data");
    assert.equal(await clientesSemData(), 2);
  });

  it("cliente inativo fica de fora", async () => {
    const id = await cliente("Inativo", "1990-09-07");
    await run(`UPDATE customers SET active = 0 WHERE id = ?`, [id]);
    assert.equal((await aniversariantesDeHoje(HOJE)).length, 0);
  });

  it("funciona na virada do ano", async () => {
    await cliente("Reveillon", "1990-01-01");
    await cliente("Natal", "1990-12-30");
    const j = await aniversariantesNaJanela(7, "2026-12-29");
    assert.deepEqual(j.map((a) => a.name), ["Natal", "Reveillon"]);
    assert.equal(j[0].dias, 1);
    assert.equal(j[1].dias, 3);
    assert.equal(j[1].data, "2027-01-01", "a data cai no ano que vem");
  });

  it("aniversario no fim do mes entra certo", async () => {
    await cliente("Fim de mes", "1990-09-30");
    const j = await aniversariantesNaJanela(3, "2026-09-28");
    assert.equal(j.length, 1);
    assert.equal(j[0].dias, 2);
  });

  it("nascido em 29/02 aparece em 28/02 nos anos comuns", async () => {
    await cliente("Bissexto", "2000-02-29");
    const j = await aniversariantesNaJanela(2, "2027-02-27");
    assert.equal(j.length, 1, "nao pode sumir");
    assert.equal(j[0].dias, 1);
  });

  it("a visao mensal traz o mes inteiro em ordem de data", async () => {
    await cliente("Dia 25", "1990-09-25");
    await cliente("Dia 3", "1990-09-03");
    await cliente("Outro mes", "1990-10-05");
    const mes = await aniversariantesDoMes(2026, 9, HOJE);
    assert.deepEqual(mes.map((a) => a.name), ["Dia 3", "Dia 25"]);
  });

  it("busca por nome e por telefone", async () => {
    await cliente("Joao Ribeiro", "1990-03-10", "11988887777");
    await cliente("Maria Souza", "1990-04-10", "11955554444");
    assert.equal((await buscarAniversariantes({ busca: "Ribeiro" }, HOJE)).length, 1);
    assert.equal((await buscarAniversariantes({ busca: "98888" }, HOJE)).length, 1);
    assert.equal((await buscarAniversariantes({ busca: "ninguem" }, HOJE)).length, 0);
  });

  it("o resumo do painel separa hoje dos proximos", async () => {
    await cliente("Hoje", "1990-09-07");
    await cliente("Depois", "1990-09-10");
    const r = await resumoAniversarios(HOJE);
    assert.equal(r.hoje.length, 1);
    assert.equal(r.proximos, 1);
  });
});

describe("rotina diaria", () => {
  beforeEach(cenario);

  it("cria o aviso do dia para cada usuario ativo", async () => {
    await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (2,'Dois','dois','x','operador')`);
    await cliente("Joao Ribeiro", "1990-09-07");

    const r = await rotinaAniversarios(HOJE);
    assert.equal(r.hoje, 1);
    assert.equal(r.avisos, 2, "um aviso para cada usuario");

    const avisos = await all<any>(`SELECT * FROM user_notifications WHERE type='aniversario'`);
    assert.equal(avisos.length, 2);
    assert.match(avisos[0].title, /Aniversariante de hoje/);
    assert.match(avisos[0].body, /Joao/);
    assert.equal(avisos[0].link, "/aniversarios");
  });

  it("rodar de novo no mesmo dia nao duplica aviso", async () => {
    await cliente("Joao", "1990-09-07");
    await rotinaAniversarios(HOJE);
    await rotinaAniversarios(HOJE);
    await rotinaAniversarios(HOJE);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM user_notifications`), 1);
  });

  it("no ano seguinte o aviso volta", async () => {
    await cliente("Joao", "1990-09-07");
    await rotinaAniversarios(HOJE);
    await rotinaAniversarios("2027-09-07");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM user_notifications`), 2);
  });

  it("avisa sobre os proximos, um aviso por dia de antecedencia", async () => {
    await cliente("Amanha", "1990-09-08");
    await cliente("Tambem amanha", "1985-09-08");
    await cliente("Em tres dias", "1990-09-10");

    const r = await rotinaAniversarios(HOJE);
    assert.equal(r.proximos, 3);
    const avisos = await all<any>(`SELECT * FROM user_notifications ORDER BY id`);
    assert.equal(avisos.length, 2, "um para amanha e um para daqui a tres dias");
    assert.match(avisos[0].body, /amanhã/);
    assert.match(avisos[1].body, /em 3 dias/);
  });

  it("o aviso nao expoe a data de nascimento", async () => {
    await cliente("Joao Ribeiro", "1990-09-07");
    await rotinaAniversarios(HOJE);
    const aviso = await one<any>(`SELECT * FROM user_notifications`);
    assert.ok(!/1990/.test(aviso.body), "ano de nascimento nao entra no aviso");
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(aviso.body));
  });

  it("nada acontece com o programa desativado", async () => {
    await config("birthday_active", "0");
    await cliente("Joao", "1990-09-07");
    const r = await rotinaAniversarios(HOJE);
    assert.equal(r.avisos, 0);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM user_notifications`), 0);
  });

  it("da para desligar so o aviso de proximos", async () => {
    await config("birthday_notify_upcoming", "0");
    await cliente("Hoje", "1990-09-07");
    await cliente("Amanha", "1990-09-08");
    await rotinaAniversarios(HOJE);
    const avisos = await all<any>(`SELECT * FROM user_notifications`);
    assert.equal(avisos.length, 1);
    assert.match(avisos[0].title, /hoje/i);
  });

  it("dia sem aniversariante nao gera aviso nenhum", async () => {
    await cliente("Outro dia", "1990-12-25");
    const r = await rotinaAniversarios(HOJE);
    assert.equal(r.avisos, 0);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM user_notifications`), 0);
  });

  it("a antecedencia configurada muda o alcance", async () => {
    await config("birthday_days_ahead", "1");
    await cliente("Amanha", "1990-09-08");
    await cliente("Em tres dias", "1990-09-10");
    const r = await rotinaAniversarios(HOJE);
    assert.equal(r.proximos, 1, "so amanha entra");
  });
});

describe("push", () => {
  beforeEach(cenario);

  async function comDispositivo(userId = 1) {
    return await insert(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label)
       VALUES (?,?, 'x','y','Aparelho')`,
      [userId, `https://web.push.apple.com/${Math.random().toString(36).slice(2)}`],
    );
  }

  it("enfileira push para o aparelho do usuario", async () => {
    await comDispositivo();
    await cliente("Joao", "1990-09-07");
    await rotinaAniversarios(HOJE);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM push_deliveries`), 1);
  });

  it("aparelho desativado nao recebe", async () => {
    const id = await comDispositivo();
    await run(`UPDATE push_subscriptions SET enabled = 0 WHERE id = ?`, [id]);
    await cliente("Joao", "1990-09-07");
    await rotinaAniversarios(HOJE);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM push_deliveries`), 0);
  });

  it("com push desligado nas configuracoes, o sino continua funcionando", async () => {
    await config("birthday_push", "0");
    await comDispositivo();
    await cliente("Joao", "1990-09-07");
    await rotinaAniversarios(HOJE);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM push_deliveries`), 0, "sem push");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM user_notifications`), 1, "mas o aviso interno fica");
  });

  it("usuario sem aparelho recebe o aviso interno mesmo assim", async () => {
    await cliente("Joao", "1990-09-07");
    await rotinaAniversarios(HOJE);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM user_notifications`), 1);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM push_deliveries`), 0);
  });
});

describe("nao quebra o que ja existia", () => {
  beforeEach(cenario);

  it("cliente antigo continua sendo criado e editado sem data", async () => {
    const id = await insert(`INSERT INTO customers (name) VALUES ('Antigo')`);
    const c = await one<any>(`SELECT * FROM customers WHERE id = ?`, [id]);
    assert.equal(c.birth_date, null);
    await run(`UPDATE customers SET name = 'Antigo editado' WHERE id = ?`, [id]);
    assert.equal((await one<any>(`SELECT name FROM customers WHERE id=?`, [id])).name, "Antigo editado");
  });

  it("da para adicionar a data depois", async () => {
    const id = await cliente("Depois", null);
    assert.equal((await aniversariantesDeHoje(HOJE)).length, 0);
    await run(`UPDATE customers SET birth_date = '1990-09-07' WHERE id = ?`, [id]);
    assert.equal((await aniversariantesDeHoje(HOJE)).length, 1);
  });

  it("e da para apagar a data sem erro", async () => {
    const id = await cliente("Some", "1990-09-07");
    await run(`UPDATE customers SET birth_date = NULL WHERE id = ?`, [id]);
    assert.equal((await aniversariantesDeHoje(HOJE)).length, 0);
  });
});
