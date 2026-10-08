/**
 * PENDÊNCIA #04 — push multi-tenant de ponta a ponta.
 *
 * Cobre o caminho real do cron (custom-worker -> paraCadaEmpresa ->
 * runNotificationScheduler) com DUAS empresas no mesmo banco:
 *
 *   1. regras de notificação: toda empresa tem as 12 regras padrão, com a
 *      UNIQUE (company_id, type) — era isso que faltava para a empresa != 1
 *      aparecer na tela de preferências e ser encontrada pelo cron
 *      (LEFT JOIN notification_rules -> NULL -> rule_enabled = false ->
 *      status 'cancelled');
 *   2. dispositivo registrado na empresa 2 + atividade criada na empresa 2
 *      -> push_deliveries criado na empresa 2 e ENVIADO (regra encontrada);
 *   3. preferências 'off' da empresa 2 cancelam o envio;
 *   4. a empresa 1 continua exatamente como antes (sem regressão).
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { all, getDb, one, resetCompanyCache, run, runWithCompany, scalar } from "../src/lib/db.ts";
import { runNotificationScheduler } from "../src/lib/push-scheduler.ts";
import { NOTIFICATION_TYPES, REGRAS_PADRAO } from "../src/lib/push-rules.ts";

const NOW = Math.floor(Date.now() / 1000);
const local = (s: number) => new Date((s - 10800) * 1000).toISOString().slice(0, 19);
let seq = 0;

beforeEach(() => {
  createTestDb();
  resetCompanyCache();
  seq = 0;
});
afterEach(() => {
  resetTestDb();
  resetCompanyCache();
});

const cont = async (sql: string, p: any[] = []) => (await scalar<number>(sql, p)) ?? 0;

/**
 * Executa EXATAMENTE o statement de backfill da migration 0034 (o mesmo texto
 * que o wrangler aplica em produção), para uma empresa criada depois das
 * migrations — é o caminho de "empresa já existente" da pendência.
 */
async function backfillDaMigration() {
  const arquivo = fs.readFileSync(path.resolve("migrations/0034_notification_rules_multi_tenant.sql"), "utf8");
  const i = arquivo.indexOf("INSERT OR IGNORE INTO notification_rules");
  const f = arquivo.indexOf(";", i);
  assert.ok(i >= 0 && f > i, "statement de backfill não encontrado na migration 0034");
  await run(arquivo.slice(i, f + 1));
}

/** Duas empresas reais, com equipe e as regras da empresa 2 via backfill 0034. */
async function duasEmpresas() {
  await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa ZB', 1)`);
  await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0), (2, 0)`);
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active) VALUES
      (10, 'Dono A', 'mt-dono-a', 'x', 'owner', 1, 1),
      (11, 'Entregador A', 'mt-ent-a', 'x', 'operacional', 1, 1),
      (20, 'Dono ZB', 'mt-dono-b', 'x', 'owner', 2, 1),
      (21, 'Entregador ZB', 'mt-ent-b', 'x', 'operacional', 2, 1)`,
  );
  await run(`INSERT INTO user_operational_roles (user_id, role) VALUES (11, 'entregador'), (21, 'entregador')`);
  await backfillDaMigration();
}

async function dispositivo(userId: number, companyId: number) {
  return run(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, label, enabled, company_id)
     VALUES (?,?,?,?,?,?,?)`,
    [userId, `https://fcm.googleapis.com/test/mt/${++seq}`, "key", "auth", `Device ${seq}`, 1, companyId],
  );
}

async function atividade(companyId: number, assignee: number | null = null) {
  return run(
    `INSERT INTO activities (source, source_id, kind, title, scheduled_at, link, assignee_id, company_id)
     VALUES ('test', ?, 'entrega', ?, ?, '/operacao/1', ?, ?)`,
    [++seq, `Atividade ${seq}`, local(NOW + 7200), assignee, companyId],
  );
}

/** O mesmo caminho do cron: uma rodada por empresa, dentro de runWithCompany. */
type Sender = () => Promise<number>;
const tick = (companyId: number, sender?: Sender) =>
  runWithCompany(companyId, () => runNotificationScheduler(getDb(), NOW, sender));

describe("regras de notificação por empresa (migration 0034)", () => {
  it("empresa existente recebe as 12 regras padrão sem tocar nas da empresa 1", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa ZB', 1)`);
    const antes = await all(`SELECT type, enabled, offsets, message FROM notification_rules WHERE company_id = 1 ORDER BY type`);
    assert.equal(antes.length, 12, "empresa 1 deveria já ter as 12 regras");

    await backfillDaMigration();

    const depois = await all(`SELECT type, enabled, offsets, message FROM notification_rules WHERE company_id = 1 ORDER BY type`);
    assert.deepEqual(depois, antes, "o backfill reescreveu regras personalizadas da empresa 1");

    const daZb = await all<{ type: string; enabled: number; offsets: string; message: string }>(
      `SELECT type, enabled, offsets, message FROM notification_rules WHERE company_id = 2 ORDER BY type`,
    );
    assert.equal(daZb.length, 12, `empresa 2 ficou com ${daZb.length} regras`);
    assert.deepEqual(
      daZb.map((r) => r.type).sort(),
      Object.keys(NOTIFICATION_TYPES).sort(),
      "regras da empresa 2 não batem com os tipos da tela",
    );
    const esperado = new Map<string, (typeof REGRAS_PADRAO)[number]>(REGRAS_PADRAO.map((r) => [r.type, r]));
    for (const r of daZb) {
      const e = esperado.get(r.type);
      assert.ok(e, `tipo ${r.type} fora de REGRAS_PADRAO`);
      assert.equal(r.enabled, 1, `${r.type} deveria nascer ligada`);
      assert.equal(r.offsets, e.offsets, `offsets padrão de ${r.type}`);
      assert.equal(r.message, e.message, `mensagem padrão de ${r.type}`);
    }

    // idempotente: rodar de novo não duplica nem muda nada
    await backfillDaMigration();
    assert.equal(await cont(`SELECT COUNT(*) FROM notification_rules WHERE company_id = 2`), 12);
    assert.equal(await cont(`SELECT COUNT(*) FROM notification_rules WHERE company_id = 1`), 12);
  });

  it("a UNIQUE é (company_id, type): mesmos tipos convivem em empresas diferentes", async () => {
    await duasEmpresas();
    assert.equal(await cont(`SELECT COUNT(*) FROM notification_rules WHERE company_id = 1 AND type = 'entrega'`), 1);
    assert.equal(await cont(`SELECT COUNT(*) FROM notification_rules WHERE company_id = 2 AND type = 'entrega'`), 1);

    // duplicata na MESMA empresa é recusada (unicidade real, não só índice)
    await assert.rejects(
      () => run(`INSERT INTO notification_rules (company_id, type, enabled, offsets, message) VALUES (2, 'entrega', 1, '[60,0]', '')`),
      /UNIQUE|constraint/i,
      "a tabela aceitou duas regras do mesmo tipo na mesma empresa",
    );

    const idx = await one<{ sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_notification_rules_company_type'`,
    );
    assert.ok(idx?.sql && /UNIQUE/i.test(idx.sql), "índice UNIQUE (company_id, type) não criado pela 0034");

    const pk = await all<{ name: string; pk: number }>(`PRAGMA table_info(notification_rules)`);
    assert.deepEqual(
      pk.filter((c) => c.pk > 0).map((c) => c.name).sort(),
      ["company_id", "type"],
      "PK ainda é a antiga, em (type) só",
    );
  });

  it("REGRAS_PADRAO, a tela (NOTIFICATION_TYPES) e a migration andam juntas", () => {
    assert.deepEqual(
      REGRAS_PADRAO.map((r) => r.type).sort(),
      Object.keys(NOTIFICATION_TYPES).sort(),
      "REGRAS_PADRAO saiu de sincronia com os tipos da tela",
    );
    assert.equal(REGRAS_PADRAO.length, 12, "esperavam-se as 12 regras padrão (0006 + 0010 + 0014)");
  });
});

describe("push na empresa 2 (cenário da pendência)", () => {
  it("dispositivo + atividade na empresa 2 geram push_deliveries da empresa 2 e a regra é encontrada", async () => {
    await duasEmpresas();
    await dispositivo(11, 1);
    await dispositivo(21, 2);
    await atividade(2, 21); // atividade criada na empresa 2, com responsável lá

    // 1) A empresa 1 roda PRIMEIRO (ordem do cron) e não pode roubar o evento
    let sends1 = 0;
    await tick(1, async () => {
      sends1++;
      return 201;
    });
    assert.equal(sends1, 0, "empresa 1 enviou push de atividade de outra empresa");
    assert.equal(
      await cont(`SELECT COUNT(*) FROM user_notifications WHERE user_id IN (10, 11)`),
      0,
      "equipe da empresa 1 foi notificada sobre atividade alheia",
    );
    assert.equal(
      await cont(`SELECT COUNT(*) FROM notification_events e JOIN activities a ON a.id = e.activity_id WHERE a.company_id = 2 AND e.processed = 1`),
      0,
      "empresa 1 marcou como processado o evento da empresa 2 (dono real nunca receberia)",
    );

    // 2) A empresa 2 roda: delivery criado NO escopo dela e enviado
    let sends2 = 0;
    await tick(2, async () => {
      sends2++;
      return 201;
    });
    assert.equal(sends2, 1, "empresa 2 não recebeu push");

    const entrega = await one<{ company_id: number; status: string }>(
      `SELECT company_id, status FROM push_deliveries WHERE company_id = 2`,
    );
    assert.ok(entrega, "push_deliveries da empresa 2 não criado");
    assert.equal(entrega.company_id, 2, "delivery gravado com DEFAULT 1");
    assert.equal(entrega.status, "sent", "delivery não enviado (regra da empresa 2 não encontrada?)");
    assert.equal(await cont(`SELECT COUNT(*) FROM push_deliveries`), 1, "só o delivery da empresa 2 deveria existir");

    // a REGRA da empresa 2 é a que habilita o envio
    const regra = await one<{ enabled: number }>(`SELECT enabled FROM notification_rules WHERE company_id = 2 AND type = 'entrega'`);
    assert.ok(regra, "regra da empresa 2 não encontrada pelo cron");
    assert.equal(regra!.enabled, 1);

    const n = await one<{ user_id: number; company_id: number }>(`SELECT user_id, company_id FROM user_notifications`);
    assert.equal(n?.user_id, 21, "notificação foi para o usuário errado");
    assert.equal(n?.company_id, 2, "notificação gravada com DEFAULT 1");
  });

  it("preferências 'off' da empresa 2 cancelam o envio (antes e depois da fila)", async () => {
    await duasEmpresas();
    await dispositivo(21, 2);

    // A) off ANTES: nada nem entra na fila de push
    await run(`INSERT INTO notification_preferences (user_id, type, mode, company_id) VALUES (21, 'entrega', 'off', 2)`);
    await atividade(2, 21);
    let sends = 0;
    await tick(2, async () => {
      sends++;
      return 201;
    });
    assert.equal(sends, 0, "opt-out da empresa 2 não impediu o envio");
    assert.equal(await cont(`SELECT COUNT(*) FROM push_deliveries WHERE company_id = 2`), 0, "delivery criado apesar do 'off'");
    assert.equal(await cont(`SELECT COUNT(*) FROM user_notifications WHERE company_id = 2`), 0, "aviso criado apesar do 'off'");

    // B) off DEPOIS: entrega já na fila é cancelada na leitura imediatamente
    //    antes do despacho (mesma semântica da empresa 1)
    await run(`DELETE FROM notification_preferences WHERE user_id = 21`);
    await atividade(2, 21);
    await tick(2); // sem sender -> nasce pending
    assert.equal(
      await cont(`SELECT COUNT(*) FROM push_deliveries WHERE company_id = 2 AND status = 'pending'`),
      1,
      "delivery não ficou pendente antes do off",
    );
    await run(`INSERT INTO notification_preferences (user_id, type, mode, company_id) VALUES (21, 'entrega', 'off', 2)`);
    sends = 0;
    await tick(2, async () => {
      sends++;
      return 201;
    });
    assert.equal(sends, 0, "envio não foi cancelado pelo 'off' da empresa 2");
    assert.equal(
      await cont(`SELECT COUNT(*) FROM push_deliveries WHERE company_id = 2 AND status = 'cancelled'`),
      1,
      "delivery pendente não virou 'cancelled'",
    );
  });

  it("sem preferência 'off', a empresa 2 envia; a empresa 1 não é afetada (regressão)", async () => {
    await duasEmpresas();
    await dispositivo(11, 1);
    await dispositivo(21, 2);
    await atividade(1, 11);
    await atividade(2, 21);

    let sends1 = 0;
    await tick(1, async () => {
      sends1++;
      return 201;
    });
    let sends2 = 0;
    await tick(2, async () => {
      sends2++;
      return 201;
    });

    assert.equal(sends1, 1, "empresa 1 deixou de receber push");
    assert.equal(sends2, 1, "empresa 2 não recebeu push");
    assert.equal(await cont(`SELECT COUNT(*) FROM push_deliveries WHERE company_id = 1 AND status = 'sent'`), 1);
    assert.equal(await cont(`SELECT COUNT(*) FROM push_deliveries WHERE company_id = 2 AND status = 'sent'`), 1);
    assert.equal(await cont(`SELECT COUNT(*) FROM push_deliveries WHERE company_id NOT IN (1, 2)`), 0);
  });
});