/**
 * Contexto de banco fora de request (runWithDb -> getDb) sob CONCORRÊNCIA.
 *
 * O `scheduled()` do Worker dispara VÁRIAS rotinas ao mesmo tempo — notificações,
 * fidelidade, aniversários, e-mails, billing — e cada uma entra por um
 * `runWithDb(env.DB, ...)`. Enquanto isso era uma variável de módulo com
 * save/restore, a primeira rotina a terminar restaurava `undefined` no `finally`
 * e as que ainda rodavam perdiam a binding: `getDb()` caía em
 * `getCloudflareContext()`, que LANÇA fora de request. Efeito real em produção:
 * o cron de e-mails falhava em todo tick (`getCloudflareContext has been called
 * without having called initOpenNextCloudflareForDev`) e as linhas da fila
 * ficavam presas em 'enviando' com `attempts` subindo, enquanto staging rodava
 * limpo — a mesma corrida, com outro interleaving.
 *
 * O teste reproduz a ordem exata que quebrava: A começa primeiro e termina
 * ANTES de B consultar. Com a variável antiga, B perdia a binding; com ALS,
 * cada execução vale pelo SEU contexto de async.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getDb, runWithDb } from "../src/lib/db.ts";

/** Gate liberado manualmente: ordena A e B sem depender de relógio. */
function gate() {
  let abrir!: () => void;
  const promessa = new Promise<void>((r) => (abrir = r));
  return { promessa, abrir };
}

describe("runWithDb — binding por contexto, não por variável de módulo", () => {
  it("mantém a binding de cada execução quando uma termina no meio da outra", async () => {
    // Sem o atalho de teste, getDb() só enxerga o contexto do agendador — é
    // exatamente o caminho do cron (fora de request, sem getCloudflareContext).
    const bancoDeTeste = globalThis.__limasTestDb;
    globalThis.__limasTestDb = undefined;
    const dbA = { rotulo: "A" } as unknown as D1Database;
    const dbB = { rotulo: "B" } as unknown as D1Database;
    const sairA = gate();
    const sairB = gate();

    try {
      const a = runWithDb(dbA, async () => {
        await sairA.promessa;
        return getDb();
      });
      const b = runWithDb(dbB, async () => {
        await sairB.promessa;
        return getDb();
      });

      // A sai PRIMEIRO: era aqui que o finally antigo apagava a binding.
      sairA.abrir();
      const dbDeA = await a;
      assert.equal(dbDeA, dbA, "A consultou depois de B e herdou a binding errada");

      // B consulta DEPOIS de A já ter terminado.
      sairB.abrir();
      const dbDeB = await b;
      assert.equal(dbDeB, dbB, "B ficou sem binding depois que A terminou");
    } finally {
      globalThis.__limasTestDb = bancoDeTeste;
    }
  });

  it("aninhamento devolve a binding da execução externa ao sair da interna", async () => {
    const bancoDeTeste = globalThis.__limasTestDb;
    globalThis.__limasTestDb = undefined;
    const dbExterno = { rotulo: "externo" } as unknown as D1Database;
    const dbInterno = { rotulo: "interno" } as unknown as D1Database;

    try {
      const rotulo = await runWithDb(dbExterno, async () => {
        const dentro = await runWithDb(dbInterno, async () => getDb());
        const depois = await getDb();
        return [(dentro as unknown as { rotulo: string }).rotulo, (depois as unknown as { rotulo: string }).rotulo];
      });
      assert.deepEqual(rotulo, ["interno", "externo"]);
    } finally {
      globalThis.__limasTestDb = bancoDeTeste;
    }
  });
});
