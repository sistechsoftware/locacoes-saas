/**
 * Estoque de ponta a ponta, com o SQL real da aplicacao rodando sobre um
 * SQLite em memoria: reserva de kits, mistura com produtos individuais,
 * cancelamento, alteracao de quantidade e concorrencia.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { alterarReserva, cancelarReserva, criarReserva, montarCenario, resetSequencia, JANELA } from "./helpers/fixtures.ts";
import {
  availabilityFor,
  checkConflicts,
  compositionDrift,
  findOverbookings,
  physicalAvailability,
  rebuildReservationComponents,
  reservationPhysicalUsage,
  scanConflicts,
} from "../src/lib/stock.ts";
import { all, run } from "../src/lib/db.ts";

async function estoqueLivre(cenario: { mesaId: number; cadeiraId: number }) {
  const mapa = await physicalAvailability(JANELA.from, JANELA.to);
  return { mesas: mapa.get(cenario.mesaId) ?? 0, cadeiras: mapa.get(cenario.cadeiraId) ?? 0 };
}

describe("estoque com kits", () => {
  let c: Awaited<ReturnType<typeof montarCenario>>;

  beforeEach(async () => {
    createTestDb();
    resetSequencia();
    c = await montarCenario(20, 80);
  });

  it("Teste 1 - reservar 1 kit deixa 19 mesas e 76 cadeiras", async () => {
    await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 1 }]);
    assert.deepEqual(await estoqueLivre(c), { mesas: 19, cadeiras: 76 });
  });

  it("Teste 2 - reservar 5 kits deixa 15 mesas e 60 cadeiras", async () => {
    await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 5 }]);
    assert.deepEqual(await estoqueLivre(c), { mesas: 15, cadeiras: 60 });
  });

  it("Teste 3 - produtos individuais: 5 mesas e 10 cadeiras deixam 15 e 70", async () => {
    await criarReserva(c.clienteId, [
      { product_id: c.mesaId, qty: 5 },
      { product_id: c.cadeiraId, qty: 10 },
    ]);
    assert.deepEqual(await estoqueLivre(c), { mesas: 15, cadeiras: 70 });
  });

  it("Teste 4 - 3 kits + 5 mesas + 10 cadeiras deixam 12 mesas e 58 cadeiras", async () => {
    await criarReserva(c.clienteId, [
      { product_id: c.kitId, qty: 3 },
      { product_id: c.mesaId, qty: 5 },
      { product_id: c.cadeiraId, qty: 10 },
    ]);
    assert.deepEqual(await estoqueLivre(c), { mesas: 12, cadeiras: 58 });
  });

  it("Teste 6 - com 15 mesas e 58 cadeiras livres o kit mostra 14 disponiveis", async () => {
    await criarReserva(c.clienteId, [
      { product_id: c.mesaId, qty: 5 },
      { product_id: c.cadeiraId, qty: 22 },
    ]);
    assert.deepEqual(await estoqueLivre(c), { mesas: 15, cadeiras: 58 });
    const kit = await availabilityFor(c.kitId, JANELA.from, JANELA.to);
    assert.equal(kit.kind, "kit");
    assert.equal(kit.available, 14);
  });

  it("kit nao aparece como estoque fisico proprio", async () => {
    const kit = await availabilityFor(c.kitId, JANELA.from, JANELA.to);
    assert.equal(kit.total, 0);
    const mapa = await physicalAvailability(JANELA.from, JANELA.to);
    assert.equal(mapa.has(c.kitId), false, "kit nao entra no mapa de estoque fisico");
  });

  it("a reserva guarda o consumo fisico expandido, mas a linha comercial continua sendo o kit", async () => {
    const id = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 10 }]);

    const linhas = await all<any>(`SELECT product_id, qty FROM reservation_items WHERE reservation_id = ?`, [id]);
    assert.deepEqual(linhas, [{ product_id: c.kitId, qty: 10 }]);

    const fisico = await reservationPhysicalUsage(id);
    const porProduto = Object.fromEntries(fisico.map((f: any) => [f.product_id, f.qty]));
    assert.equal(porProduto[c.mesaId], 10);
    assert.equal(porProduto[c.cadeiraId], 40);
  });
});

describe("bloqueio de estoque negativo", () => {
  let c: Awaited<ReturnType<typeof montarCenario>>;

  beforeEach(async () => {
    createTestDb();
    resetSequencia();
    c = await montarCenario(3, 10);
  });

  it("Teste 5 - 3 kits com 3 mesas e 10 cadeiras e recusado, informando 2 kits possiveis", async () => {
    const conflitos = await checkConflicts([{ product_id: c.kitId, qty: 3 }], JANELA.from, JANELA.to);
    assert.equal(conflitos.length, 1);
    assert.equal(conflitos[0].kind, "kit");
    assert.equal(conflitos[0].available, 2);
    assert.equal(conflitos[0].missing, 1);
  });

  it("2 kits passam, 3 nao", async () => {
    assert.equal((await checkConflicts([{ product_id: c.kitId, qty: 2 }], JANELA.from, JANELA.to)).length, 0);
    assert.equal((await checkConflicts([{ product_id: c.kitId, qty: 3 }], JANELA.from, JANELA.to)).length, 1);
  });

  it("conflito considera o que ja esta reservado por outra reserva", async () => {
    await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 2 }]);
    const conflitos = await checkConflicts([{ product_id: c.kitId, qty: 1 }], JANELA.from, JANELA.to);
    assert.equal(conflitos.length, 1);
    assert.equal(conflitos[0].available, 0);
  });
});

describe("cancelamento e alteracao", () => {
  let c: Awaited<ReturnType<typeof montarCenario>>;

  beforeEach(async () => {
    createTestDb();
    resetSequencia();
    c = await montarCenario(20, 80);
  });

  it("Teste 7 - cancelar 5 kits devolve 5 mesas e 20 cadeiras", async () => {
    const id = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 5 }]);
    assert.deepEqual(await estoqueLivre(c), { mesas: 15, cadeiras: 60 });

    await cancelarReserva(id);
    assert.deepEqual(await estoqueLivre(c), { mesas: 20, cadeiras: 80 });
  });

  it("Teste 8 - alterar de 10 para 6 kits libera 4 mesas e 16 cadeiras", async () => {
    const id = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 10 }]);
    assert.deepEqual(await estoqueLivre(c), { mesas: 10, cadeiras: 40 });

    await alterarReserva(id, [{ product_id: c.kitId, qty: 6 }]);
    assert.deepEqual(await estoqueLivre(c), { mesas: 14, cadeiras: 56 });

    const fisico = await reservationPhysicalUsage(id);
    const porProduto = Object.fromEntries(fisico.map((f: any) => [f.product_id, f.qty]));
    assert.equal(porProduto[c.mesaId], 6);
    assert.equal(porProduto[c.cadeiraId], 24);
  });

  it("nao duplica nem perde movimentacao ao regravar varias vezes", async () => {
    const id = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 5 }]);
    await rebuildReservationComponents(id);
    await rebuildReservationComponents(id);
    assert.deepEqual(await estoqueLivre(c), { mesas: 15, cadeiras: 60 });
  });

  it("reserva cancelada e depois reativada volta a ocupar estoque", async () => {
    const id = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 5 }]);
    await cancelarReserva(id);
    assert.deepEqual(await estoqueLivre(c), { mesas: 20, cadeiras: 80 });
    await run(`UPDATE reservations SET status = 'confirmada' WHERE id = ?`, [id]);
    assert.deepEqual(await estoqueLivre(c), { mesas: 15, cadeiras: 60 });
  });
});

describe("integridade historica da composicao", () => {
  it("alterar o kit depois nao muda reservas ja registradas", async () => {
    createTestDb();
    resetSequencia();
    const c = await montarCenario(20, 80);

    const id = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 2 }]);
    // composicao passa de 4 para 6 cadeiras
    await run(`UPDATE product_components SET quantity = 6 WHERE parent_product_id = ? AND component_product_id = ?`, [
      c.kitId,
      c.cadeiraId,
    ]);

    const fisico = await reservationPhysicalUsage(id);
    const porProduto = Object.fromEntries(fisico.map((f: any) => [f.product_id, f.qty]));
    assert.equal(porProduto[c.cadeiraId], 8, "a reserva antiga mantem 4 cadeiras por kit");

    // uma reserva nova ja usa a composicao nova
    const novo = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 2 }]);
    const fisicoNovo = await reservationPhysicalUsage(novo);
    const porProdutoNovo = Object.fromEntries(fisicoNovo.map((f: any) => [f.product_id, f.qty]));
    assert.equal(porProdutoNovo[c.cadeiraId], 12);
  });
});

describe("concorrencia", () => {
  it("Teste 9 - dois usuarios reservando o ultimo kit: so um sobrevive", async () => {
    createTestDb();
    resetSequencia();
    // estoque exato para 2 kits
    const c = await montarCenario(2, 8);

    // as duas gravacoes passam pela validacao previa antes de qualquer commit
    const conflitosA = await checkConflicts([{ product_id: c.kitId, qty: 2 }], JANELA.from, JANELA.to);
    const conflitosB = await checkConflicts([{ product_id: c.kitId, qty: 2 }], JANELA.from, JANELA.to);
    assert.equal(conflitosA.length, 0);
    assert.equal(conflitosB.length, 0);

    // e so entao gravam, uma depois da outra
    const idA = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 2 }]);
    const idB = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 2 }]);

    // a mais antiga nao enxerga a mais nova: continua valida
    assert.deepEqual(await findOverbookings(idA), []);

    // a mais nova enxerga a anterior e detecta o estouro -> desiste
    const excessoB = await findOverbookings(idB);
    assert.ok(excessoB.length > 0, "a segunda reserva precisa detectar o estouro");
    assert.equal(excessoB.find((e) => e.product_id === c.mesaId)?.excess, 2);

    // aplicando o rollback da perdedora, o estoque volta a ser consistente
    await run(`DELETE FROM reservation_item_components WHERE reservation_id = ?`, [idB]);
    await run(`DELETE FROM reservation_items WHERE reservation_id = ?`, [idB]);
    await run(`DELETE FROM reservations WHERE id = ?`, [idB]);

    assert.deepEqual(await findOverbookings(idA), []);
    const livre = await physicalAvailability(JANELA.from, JANELA.to);
    assert.equal(livre.get(c.mesaId), 0);
    assert.equal(livre.get(c.cadeiraId), 0);
  });

  it("uma unica reserva dentro do estoque nao acusa estouro", async () => {
    createTestDb();
    resetSequencia();
    const c = await montarCenario(2, 8);
    const id = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 2 }]);
    assert.deepEqual(await findOverbookings(id), []);
  });
});

describe("composicao desatualizada", () => {
  it("aponta a divergencia quando o kit muda depois da reserva, e a atualizacao corrige", async () => {
    createTestDb();
    resetSequencia();
    const c = await montarCenario(20, 80);

    // kit cadastrado incompleto: so cadeiras, sem a mesa
    await run(`DELETE FROM product_components WHERE parent_product_id = ? AND component_product_id = ?`, [
      c.kitId,
      c.mesaId,
    ]);

    const id = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 5 }]);
    assert.deepEqual(await estoqueLivre(c), { mesas: 20, cadeiras: 60 }, "mesa ainda nao e consumida");
    assert.deepEqual(await compositionDrift(id), [], "sem divergencia enquanto o kit nao muda");

    // composicao corrigida: passa a incluir 1 mesa por kit
    await run(`INSERT INTO product_components (parent_product_id, component_product_id, quantity) VALUES (?,?,1)`, [
      c.kitId,
      c.mesaId,
    ]);

    const drift = await compositionDrift(id);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].product, "Mesa");
    assert.equal(drift[0].gravado, 0);
    assert.equal(drift[0].atual, 5);

    // a reserva antiga so muda quando alguem confirma a atualizacao
    await rebuildReservationComponents(id);
    assert.deepEqual(await compositionDrift(id), []);
    assert.deepEqual(await estoqueLivre(c), { mesas: 15, cadeiras: 60 });
  });
});

describe("varredura de conflitos", () => {
  it("acha as reservas que estouram o estoque, sem percorrer uma a uma", async () => {
    createTestDb();
    resetSequencia();
    const c = await montarCenario(2, 8);

    const idA = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 2 }]);
    const idB = await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 2 }]);

    const conflitos = await scanConflicts("2026-01-01");
    const envolvidas = conflitos.map((x) => x.reservation_id).sort();
    assert.deepEqual(envolvidas, [idA, idB].sort(), "as duas reservas dividem a mesma janela estourada");
    assert.ok(conflitos[0].faltas.length > 0);
  });

  it("nao acusa nada quando tudo cabe", async () => {
    createTestDb();
    resetSequencia();
    const c = await montarCenario(20, 80);
    await criarReserva(c.clienteId, [{ product_id: c.kitId, qty: 5 }]);
    assert.deepEqual(await scanConflicts("2026-01-01"), []);
  });
});
