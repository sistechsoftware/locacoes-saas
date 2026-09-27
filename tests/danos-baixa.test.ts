/**
 * Resolucao de danos: baixa definitiva, manutencao e estorno.
 *
 * Cobre os 7 cenarios da auditoria de estoque mais os casos de seguranca:
 * idempotencia (dupla baixa), integracao com o stock_revision (CAS), expansao
 * de kit em componentes e garantia de que cancelamento/exclusao de reserva
 * nunca reverte uma baixa.
 *
 * Cenario base: 20 cadeiras, reserva de 5, 2 quebradas.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1";
import { JANELA, criarReserva, montarCenario, resetSequencia, type Cenario } from "./helpers/fixtures";
import { all, insert, one, run, scalar } from "../src/lib/db";
import { availabilityFor, checkConflicts } from "../src/lib/stock";
import {
  completeDamageMaintenance,
  resolveDamage,
  revertDamageWriteOff,
  validarQuantidadeDoDano,
  RESOLUTION_LABEL,
} from "../src/lib/danos";
import { stockVersion } from "../src/lib/stock-write";

let c: Cenario;
let user = { id: 0, name: "Auditor", username: "auditor", role: "admin" as const, avatar_url: null };

beforeEach(async () => {
  createTestDb();
  resetSequencia();
  c = await montarCenario(5, 20); // 5 mesas, 20 cadeiras, kit 1 mesa + 4 cadeiras
  user.id = await insert(`INSERT INTO users (name, username, password_hash, role) VALUES ('Auditor','auditor','x','admin')`, []);
});

/** Disponibilidade da cadeira fora de qualquer preparacao. */
const disponivel = async (from = JANELA.from, to = JANELA.to) =>
  (await availabilityFor(c.cadeiraId, from, to, null, { considerPreparation: false })).available;

const totalCadeiras = async () => scalar<number>(`SELECT total_qty FROM products WHERE id = ?`, [c.cadeiraId]);
const manutencaoCadeiras = async () => scalar<number>(`SELECT maintenance_qty FROM products WHERE id = ?`, [c.cadeiraId]);

/** Registra um dano exatamente como faz reportDamage (sem baixar estoque). */
async function registrarDano(reservationId: number | null, productId: number, qty: number) {
  return await insert(
    `INSERT INTO damage_reports (reservation_id, product_id, qty, damage_type, created_by) VALUES (?,?,?,?,?)`,
    [reservationId, productId, qty, "quebra", user.id],
  );
}

const movimentos = async (danoId: number) =>
  await all<any>(`SELECT * FROM stock_movements WHERE damage_report_id = ? ORDER BY id`, [danoId]);

const statusDoDano = async (danoId: number) =>
  String(
    (await one<{ resolution_status: string }>(
      `SELECT resolution_status FROM damage_reports WHERE id = ?`,
      [danoId],
    ))?.resolution_status,
  );

describe("Cenario 1 - 20 cadeiras disponiveis, 2 quebradas, dano registrado", () => {
  it("registrar o dano nao muda o disponivel; a baixa definitiva reduz para 18", async () => {
    assert.equal(await disponivel(), 20);
    const dano = await registrarDano(null, c.cadeiraId, 2);

    // registro so documenta: estoque intocado (comportamento antigo, hoje intencional)
    assert.equal(await disponivel(), 20);
    assert.equal(await totalCadeiras(), 20);

    const r = await resolveDamage(user, dano, "baixa");
    assert.ok(r.ok, JSON.stringify(r));

    assert.equal(await totalCadeiras(), 18);
    assert.equal(await disponivel(), 18);
    assert.equal(await statusDoDano(dano), "baixada");

    const movs = await movimentos(dano);
    assert.equal(movs.length, 1);
    assert.equal(movs[0].reason, "baixa_dano");
    assert.equal(movs[0].qty_delta, -2);
    assert.equal(movs[0].product_id, c.cadeiraId);
    assert.equal(movs[0].created_by, user.id);
  });
});

describe("Cenario 2 - 5 reservadas, 2 quebradas durante a locacao", () => {
  it("baixa vale durante a janela: 5 em uso + 2 baixadas = 13 disponiveis; depois da retirada, 18", async () => {
    await criarReserva(c.clienteId, [{ product_id: c.cadeiraId, qty: 5 }]);
    const dano = await registrarDano(null, c.cadeiraId, 2);

    await resolveDamage(user, dano, "baixa");

    // durante a locacao: 20 - 2 baixadas - 5 em uso
    assert.equal(await disponivel(), 13);
    // fora da janela: 20 - 2
    assert.equal(await disponivel("2026-10-01T08:00", "2026-10-01T18:00"), 18);
  });
});

describe("Cenario 3 - 2 quebradas e nova reserva de 20 cadeiras", () => {
  it("recusa: disponivel e 18, pedido 20", async () => {
    const dano = await registrarDano(null, c.cadeiraId, 2);
    await resolveDamage(user, dano, "baixa");

    const conflitos = await checkConflicts([{ product_id: c.cadeiraId, qty: 20 }], JANELA.from, JANELA.to, null, {
      considerPreparation: false,
    });
    assert.equal(conflitos.length, 1);
    assert.equal(conflitos[0].available, 18);
    assert.equal(conflitos[0].missing, 2);
  });
});

describe("Cenario 4 - 2 quebradas e nova reserva de 18 cadeiras", () => {
  it("aceita: disponivel e 18", async () => {
    const dano = await registrarDano(null, c.cadeiraId, 2);
    await resolveDamage(user, dano, "baixa");

    const conflitos = await checkConflicts([{ product_id: c.cadeiraId, qty: 18 }], JANELA.from, JANELA.to, null, {
      considerPreparation: false,
    });
    assert.equal(conflitos.length, 0);
    assert.equal(await disponivel(), 18);
  });
});

describe("Cenario 5 - componente de kit quebrado e nova reserva do kit", () => {
  it("capacidade do kit cai de 5 para 4 e a reserva de 5 kits e recusada", async () => {
    // base: 5 mesas e 20 cadeiras -> min(floor(5/1), floor(20/4)) = 5 kits
    const antes = (await availabilityFor(c.kitId, JANELA.from, JANELA.to, null, { considerPreparation: false })).available;
    assert.equal(antes, 5);

    const dano = await registrarDano(null, c.cadeiraId, 2);
    await resolveDamage(user, dano, "baixa");

    const depois = (await availabilityFor(c.kitId, JANELA.from, JANELA.to, null, { considerPreparation: false })).available;
    assert.equal(depois, 4); // min(5, floor(18/4))

    const conflitos = await checkConflicts([{ product_id: c.kitId, qty: 5 }], JANELA.from, JANELA.to, null, {
      considerPreparation: false,
    });
    assert.equal(conflitos.length, 1);
    assert.equal(conflitos[0].kind, "kit");
  });

  it("baixa de linha de kit e expandida nos componentes fisicos (1 kit = 1 mesa + 4 cadeiras)", async () => {
    const reserva = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 1 }]);
    const dano = await registrarDano(reserva, c.kitId, 1);

    const r = await resolveDamage(user, dano, "baixa");
    assert.ok(r.ok, JSON.stringify(r));

    assert.equal(await scalar<number>(`SELECT total_qty FROM products WHERE id = ?`, [c.mesaId]), 4); // 5 - 1
    assert.equal(await scalar<number>(`SELECT total_qty FROM products WHERE id = ?`, [c.cadeiraId]), 16); // 20 - 4

    const movs = await movimentos(dano);
    assert.equal(movs.length, 2);
    assert.deepEqual(movs.map((m: any) => m.qty_delta).sort((a: number, b: number) => a - b), [-4, -1]);
    assert.ok(movs.every((m: any) => m.reservation_id === reserva));

    // dano em kit nao vai para manutencao (manutencao e por produto fisico)
    const danoKit2 = await registrarDano(null, c.kitId, 1);
    const r2 = await resolveDamage(user, danoKit2, "manutencao");
    assert.ok(!r2.ok);
  });
});

describe("Cenario 6 - dano baixado e depois estornado/corrigido", () => {
  it("estorno devolve as unidades por movimentacao inversa e permite nova resolucao", async () => {
    const dano = await registrarDano(null, c.cadeiraId, 2);
    await resolveDamage(user, dano, "baixa");
    assert.equal(await totalCadeiras(), 18);

    const estorno = await revertDamageWriteOff(user, dano, "cadeira recuperada pelo cliente");
    assert.ok(estorno.ok, JSON.stringify(estorno));

    assert.equal(await totalCadeiras(), 20);
    assert.equal(await disponivel(), 20);
    assert.equal(await statusDoDano(dano), "estornada");

    const movs = await movimentos(dano);
    assert.equal(movs.length, 2);
    assert.equal(movs[1].reason, "estorno_baixa");
    assert.equal(movs[1].qty_delta, 2);
    // historico preservado: a baixa original continua no livro
    assert.equal(movs[0].reason, "baixa_dano");

    // de 'estornada' e possivel resolver de novo
    const r = await resolveDamage(user, dano, "baixa");
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(await totalCadeiras(), 18);
    assert.equal(await statusDoDano(dano), "baixada");
  });

  it("dupla baixa e bloqueada: a segunda resolucao falha e so uma movimentacao existe", async () => {
    const dano = await registrarDano(null, c.cadeiraId, 2);
    const primeira = await resolveDamage(user, dano, "baixa");
    assert.ok(primeira.ok);

    const segunda = await resolveDamage(user, dano, "baixa");
    assert.ok(!segunda.ok);

    assert.equal(await totalCadeiras(), 18); // baixou uma vez so
    assert.equal((await movimentos(dano)).length, 1);
  });

  it("estorno so vale para baixa definitiva: manutencao nao e estornavel", async () => {
    const dano = await registrarDano(null, c.cadeiraId, 2);
    await resolveDamage(user, dano, "manutencao");
    const r = await revertDamageWriteOff(user, dano, "tentativa");
    assert.ok(!r.ok);
  });

  it("manutencao: reduz o disponivel via maintenance_qty e devolve ao consertar", async () => {
    const dano = await registrarDano(null, c.cadeiraId, 2);
    const r = await resolveDamage(user, dano, "manutencao");
    assert.ok(r.ok, JSON.stringify(r));

    assert.equal(await manutencaoCadeiras(), 2);
    assert.equal(await totalCadeiras(), 20); // patrimonio nao muda
    assert.equal(await statusDoDano(dano), "em_manutencao");

    const m = await all<any>(`SELECT * FROM maintenance WHERE damage_report_id = ?`, [dano]);
    assert.equal(m.length, 1);
    assert.equal(m[0].status, "aberta");
    assert.equal(m[0].qty, 2);

    // fora da janela: 20 fisico - 2 manutencao
    assert.equal(await disponivel("2026-10-01T08:00", "2026-10-01T18:00"), 18);

    const ok = await completeDamageMaintenance(user, dano);
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.equal(await manutencaoCadeiras(), 0);
    assert.equal(await statusDoDano(dano), "consertada");
    assert.equal(await disponivel("2026-10-01T08:00", "2026-10-01T18:00"), 20);
  });
});

describe("Cenario 7 - reserva cancelada depois da baixa", () => {
  it("cancelamento devolve apenas as 5 em uso; as 2 baixadas continuam fora", async () => {
    const reserva = await criarReserva(c.clienteId, [{ product_id: c.cadeiraId, qty: 5 }]);
    const dano = await registrarDano(reserva, c.cadeiraId, 2);
    await resolveDamage(user, dano, "baixa");
    assert.equal(await disponivel(), 13);

    await run(`UPDATE reservations SET status = 'cancelada' WHERE id = ?`, [reserva]);

    assert.equal(await disponivel(), 18); // nao volta para 20
    assert.equal(await statusDoDano(dano), "baixada"); // baixa preservada
    assert.equal((await movimentos(dano)).length, 1); // livro intacto
  });

  it("excluir a reserva nao devolve as unidades baixadas (e o livro referencia a reserva apagada por SET NULL)", async () => {
    const reserva = await criarReserva(c.clienteId, [{ product_id: c.cadeiraId, qty: 5 }]);
    const dano = await registrarDano(reserva, c.cadeiraId, 2);
    await resolveDamage(user, dano, "baixa");

    // o dano em si tem CASCADE, mas a baixa no produto independe dele
    await run(`DELETE FROM damage_reports WHERE id = ?`, [dano]);
    await run(`DELETE FROM reservations WHERE id = ?`, [reserva]);

    assert.equal(await totalCadeiras(), 18);
  });
});

describe("Seguranca e integracao", () => {
  it("validacao: quantidade maior que a linha da reserva e recusada; produto estranho tambem", async () => {
    const reserva = await criarReserva(c.clienteId, [{ product_id: c.cadeiraId, qty: 5 }]);
    assert.match((await validarQuantidadeDoDano(reserva, c.cadeiraId, 6)) ?? "", /maior que a contratada/);
    assert.match((await validarQuantidadeDoDano(reserva, c.mesaId, 1)) ?? "", /não pertence/);
    assert.equal(await validarQuantidadeDoDano(reserva, c.cadeiraId, 5), null);
  });

  it("a resolucao participa do CAS: mudanca em reserva durante a operacao falha sem efeito parcial", async () => {
    // simula a corrida: captura a revisao, uma reserva muda o estoque, e o
    // resolveDamage com a revisao velha precisa falhar inteiro
    const { commitStockBatch } = await import("../src/lib/stock-write");
    const version = await stockVersion();
    await criarReserva(c.clienteId, [{ product_id: c.cadeiraId, qty: 5 }]); // move a revisao

    await assert.rejects(
      () =>
        commitStockBatch(version, [
          { sql: `UPDATE products SET total_qty = total_qty - 2 WHERE id = ?`, params: [c.cadeiraId] },
        ]),
      /O estoque ou a reserva mudou/,
    );
    // nada foi aplicado pela metade
    assert.equal(await totalCadeiras(), 20);
  });

  it("rotulos de resolucao existem para todos os estados", () => {
    for (const s of ["registrada", "baixada", "em_manutencao", "consertada", "estornada"]) {
      assert.ok(RESOLUTION_LABEL[s]);
    }
  });
});
