/**
 * Lote de leituras (emLoteLeituras) — o mecanismo que derruba o custo de
 * /reservas/[id] em produção.
 *
 * O D1 processa UMA consulta por vez (docs de limites: "single-threaded, one
 * query at a time"), então cada all/one é uma volta à rede até a primária.
 * A tela de detalhe faz ~37 leituras; sem lote eram ~37 idas — com lote, uma
 * por ONDA (batch conta como 1 ida na observabilidade de perf.ts).
 *
 * Estes testes travam o contrato:
 *   1. onda inteira vira UM batch (e os dados são idênticos aos do caminho
 *      sem lote);
 *   2. uma leitura que só nasce depois de outra vira UMA onda nova (a ordem
 *      das consultas nunca muda, só o agrupamento);
 *   3. um statement ruim derruba só ele mesmo (fallback statement a
 *      statement) — o `batch()` do D1 é atômico e abortaria a onda inteira;
 *   4. escrita continua IMEDIATA dentro do lote, então quem lê logo depois
 *      da escrita enxerga o dado;
 *   5. exceção (redirect/notFound da página) propaga sem deixar leitura
 *      pendurada.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, type FakeD1 } from "./helpers/d1";
import { all, emLoteLeituras, insert, one, run, scalar } from "../src/lib/db";
import { comContextoDeInvocacao, contextoAtual } from "../src/lib/perf";

let db: FakeD1;

beforeEach(() => {
  db = createTestDb();
});

/** Idas ao D1 cometidas por `fn` (um batch conta como 1). */
async function idas(fn: () => Promise<unknown>): Promise<number> {
  let consultas = -1;
  await comContextoDeInvocacao(async () => {
    await fn();
    consultas = contextoAtual()?.consultas ?? -1;
  });
  return consultas;
}

/** As mesmas quatro leituras independentes da tela de detalhe. */
function leiturasIndependentes() {
  return Promise.all([
    all<{ id: number }>(`SELECT id FROM customers ORDER BY id`),
    all<{ id: number }>(`SELECT id FROM products ORDER BY id`),
    one<{ n: number }>(`SELECT COUNT(*) AS n FROM reservations`),
    scalar<number>(`SELECT COUNT(*) FROM sessions`),
  ]);
}

describe("emLoteLeituras — agrupamento por onda", () => {
  it("uma onda de leituras independentes vira UM batch (1 ida, não 4)", async () => {
    const semLote = await idas(leiturasIndependentes);
    const emLote = await idas(() => emLoteLeituras(leiturasIndependentes));

    assert.equal(semLote, 4, "fora do lote cada leitura é uma ida ao D1");
    assert.equal(emLote, 1, "dentro do lote a onda inteira cabe num batch");
  });

  it("os dados lidos no lote são idênticos aos do caminho sem lote", async () => {
    await insert(`INSERT INTO customers (name, company_id) VALUES (?, 1)`, ["Cliente do lote"]);
    await insert(`INSERT INTO products (code, name, kind, company_id) VALUES (?, ?, 'simples', 1)`, [
      "LOTE-1",
      "Mesa do lote",
    ]);

    const fora = await leiturasIndependentes();
    const dentro = await emLoteLeituras(leiturasIndependentes);
    assert.deepEqual(dentro, fora);
    assert.equal(dentro[0][0]?.id, 1);
    assert.equal(typeof dentro[2]?.n, "number");
  });

  it("leitura que depende de outra vira uma onda nova — 2 batches, nunca uma mistura", async () => {
    const consultas = await idas(() =>
      emLoteLeituras(async () => {
        const n = await scalar<number>(`SELECT COUNT(*) FROM companies`);
        assert.ok(n >= 1, "a primeira leitura resolve antes da segunda nascer");
        // só depois da primeira resposta é que estas duas são disparadas —
        // juntas, na mesma volta, elas cabem no MESMO batch
        await Promise.all([all(`SELECT id FROM customers`), all(`SELECT id FROM products`)]);
      }),
    );
    assert.equal(consultas, 2, "onda 1 = 1 batch, onda 2 = 1 batch");
  });

  it("sem contexto de requisição o lote continua funcionando (passthrough idem)", async () => {
    const total = await emLoteLeituras(() => scalar<number>(`SELECT COUNT(*) FROM companies`));
    assert.ok(total >= 1);
  });
});

describe("emLoteLeituras — segurança", () => {
  it("statement quebrado derruba só ele; os vizinhos da mesma onda respondem", async () => {
    const resultados = await emLoteLeituras(() =>
      Promise.allSettled([
        all(`SELECT id FROM customers`),
        all(`SELECT id FROM tabela_que_nao_existe`),
        scalar<number>(`SELECT COUNT(*) FROM sessions`),
      ]),
    );

    assert.equal(resultados[0].status, "fulfilled");
    assert.equal(resultados[2].status, "fulfilled");
    assert.equal(resultados[1].status, "rejected");
    assert.match(String((resultados[1] as PromiseRejectedResult).reason), /tabela_que_nao_existe|no such table/i);
  });

  it("escrita dentro do lote é imediata: a leitura seguinte enxerga o dado", async () => {
    await emLoteLeituras(async () => {
      const id = await insert(`INSERT INTO customers (name, company_id) VALUES (?, 1)`, ["Pós-escrita"]);
      const linha = await one<{ name: string }>(`SELECT name FROM customers WHERE id = ?`, [id]);
      assert.equal(linha?.name, "Pós-escrita");
    });
  });

  it("exceção da página (redirect/notFound) propaga e nada fica pendurado", async () => {
    await assert.rejects(
      emLoteLeituras(async () => {
        // leitura disparada e NÃO esperada — o finally precisa drená-la
        void all(`SELECT id FROM customers`);
        throw new Error("redirect simulado");
      }),
      { message: "redirect simulado" },
    );
    // e a aplicação segue operando normalmente depois
    await run(`INSERT INTO customers (name, company_id) VALUES (?, 1)`, ["depois do erro"]);
    assert.equal((await scalar<number>(`SELECT COUNT(*) FROM customers`)), 1);
  });
});
