import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1";
import { all, getDb, insert, one, run, scalar } from "../src/lib/db";
import { eligible, safePushEndpoint, validOffsets, validateSubscription } from "../src/lib/push-rules";
import { createECDH, randomBytes } from "node:crypto";
import { explicaFalha, runNotificationScheduler, sanitizeError, webPushSender } from "../src/lib/push-scheduler";
import { montarCenario, criarReserva } from "./helpers/fixtures";

const NOW = Math.floor(Date.now()/1000);
const local = (seconds:number) => new Date((seconds-10800)*1000).toISOString().slice(0,19);
let seq=0;
beforeEach(()=>{createTestDb();seq=0;});
afterEach(resetTestDb);
async function user(roles:string[]=[],admin=false) {
  const id=await insert("INSERT INTO users(name,username,password_hash,role) VALUES (?,?,?,?)",[`User ${++seq}`,`u${seq}`,"test",admin?"admin":"operador"]);
  for(const role of roles) await run("INSERT INTO user_operational_roles(user_id,role) VALUES (?,?)",[id,role]);
  return id;
}
async function device(userId:number,enabled=1) {
  return insert("INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth,label,enabled) VALUES (?,?,?,?,?,?)",[userId,`https://fcm.googleapis.com/test/${++seq}`,"key","auth",`Device ${seq}`,enabled]);
}
async function activity(kind="entrega",assignee:number|null=null,scheduled=NOW+7200) {
  return insert("INSERT INTO activities(source,source_id,kind,title,scheduled_at,link,assignee_id) VALUES ('test',?,?,?,?,?,?)",[++seq,kind,`Atividade ${seq}`,local(scheduled),"/operacao/1",assignee]);
}
async function recipients(){return (await all<{user_id:number}>("SELECT DISTINCT user_id FROM user_notifications ORDER BY user_id")).map(r=>r.user_id);}
const tick = (sender?: (s:any,p:any)=>Promise<number>,now=NOW)=>runNotificationScheduler(getDb(),now,sender);

describe("regras e seguranca push",()=>{
  it("admin nao e inscrito implicitamente",async()=>{await user([],true);const driver=await user(["entregador"]);await activity();await tick();assert.deepEqual(await recipients(),[driver]);});
  it("isola retirada, montagem, financeiro e separacao",async()=>{const pick=await user(["retirador"]);await user(["entregador"]);await user(["financeiro"]);await user(["separador"]);await activity("retirada");await tick();assert.deepEqual(await recipients(),[pick]);});
  it("aceita multiplas funcoes sem duplicar",async()=>{const u=await user(["entregador","gestor"]);await activity();await tick();assert.equal(await scalar("SELECT COUNT(*) FROM user_notifications WHERE user_id=?",[u]),1);});
  it("responsavel exclusivo nao precisa de funcao",async()=>{await user(["entregador"]);const direct=await user();await activity("entrega",direct);await tick();assert.deepEqual(await recipients(),[direct]);});
  it("opt-in explicito inclui usuario sem funcao",async()=>{const u=await user();await run("INSERT INTO notification_preferences VALUES (?,'entrega','on')",[u]);await activity();await tick();assert.deepEqual(await recipients(),[u]);});
  it("opt-out prevalece mesmo sobre atribuicao",async()=>{const u=await user(["entregador"]);await run("INSERT INTO notification_preferences VALUES (?,'entrega','off')",[u]);await activity("entrega",u);await tick();assert.deepEqual(await recipients(),[]);});
  it("usuario inativo nao recebe",async()=>{const u=await user(["gestor"]);await run("UPDATE users SET active=0 WHERE id=?",[u]);await activity();await tick();assert.deepEqual(await recipients(),[]);});
  it("valida offsets",()=>{assert.deepEqual(validOffsets([60,60,0]),[60,0]);assert.throws(()=>validOffsets([61]));assert.throws(()=>validOffsets("60"));});
  it("bloqueia endpoints arbitrarios, privados, credenciais, portas e subdominios falsos",()=>{
    for(const url of ["http://fcm.googleapis.com/test","https://localhost/a","https://127.0.0.1/a","https://fcm.googleapis.com.evil.test/a","https://evilpush.apple.com/a","https://user@fcm.googleapis.com/a","https://fcm.googleapis.com:8443/a"]) assert.equal(safePushEndpoint(url),false,url);
    for(const url of ["https://fcm.googleapis.com/test","https://web.push.apple.com/test","https://updates.push.services.mozilla.com/test"]) assert.equal(safePushEndpoint(url),true);
    assert.throws(()=>validateSubscription({endpoint:"https://fcm.googleapis.com/test",keys:{auth:"bad",p256dh:"bad"}}));
  });
});
describe("fila duravel e dispositivos",()=>{
  it("dispositivo desativado nao envia; historico interno permanece",async()=>{const u=await user(["entregador"]);await device(u,0);await activity();let sends=0;await tick(async()=>{sends++;return 201;});assert.equal(sends,0);assert.equal(await scalar("SELECT COUNT(*) FROM user_notifications"),1);});
  it("sem dispositivo tambem gera central interna",async()=>{await user(["entregador"]);await activity();await tick();assert.equal(await scalar("SELECT COUNT(*) FROM user_notifications"),1);});
  it("dois dispositivos recebem uma vez cada mesmo repetindo cron",async()=>{const u=await user(["entregador"]);await device(u);await device(u);await activity();let sends=0;const sender=async()=>{sends++;return 201;};await tick(sender);await tick(sender);assert.equal(sends,2);assert.equal(await scalar("SELECT COUNT(*) FROM push_deliveries WHERE status='sent'"),2);});
  it("desativacao de um dispositivo nao afeta o outro",async()=>{const u=await user(["entregador"]);const d=await device(u);await device(u);await activity();await tick();await run("UPDATE push_subscriptions SET enabled=0 WHERE id=?",[d]);let sends=0;await tick(async()=>{sends++;return 201;});assert.equal(sends,1);});
  it("mudanca de preferencia invalida envio pendente",async()=>{const u=await user(["entregador"]);await device(u);await activity();await tick();await run("INSERT INTO notification_preferences VALUES (?,'entrega','off')",[u]);let sends=0;await tick(async()=>{sends++;return 201;});assert.equal(sends,0);});
  it("remocao da funcao impede envio pendente",async()=>{const u=await user(["entregador"]);await device(u);await activity();await tick();await run("DELETE FROM user_operational_roles WHERE user_id=?",[u]);let sends=0;await tick(async()=>{sends++;return 201;});assert.equal(sends,0);});
  it("HTTP 410 desativa inscricao expirada sem apagar historico",async()=>{const u=await user(["entregador"]);const d=await device(u);await activity();await tick(async()=>410);assert.equal(await scalar("SELECT enabled FROM push_subscriptions WHERE id=?",[d]),0);assert.equal(await scalar("SELECT COUNT(*) FROM user_notifications"),1);});
  it("HTTP 503 reenvia com mesmo identificador e backoff",async()=>{const u=await user(["entregador"]);await device(u);await activity();const ids:number[]=[];await tick(async(_s,p)=>{ids.push(p.id);return 503;});await tick(async()=>{throw Error("nao deve tentar antes do backoff");});await tick(async(_s,p)=>{ids.push(p.id);return 201;},NOW+121);assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);});
  it("falha de rede nao elimina a notificacao interna",async()=>{const u=await user(["entregador"]);await device(u);await activity();await tick(async()=>{throw Error("offline");});assert.equal(await scalar("SELECT COUNT(*) FROM user_notifications"),1);assert.equal(await scalar("SELECT status FROM push_deliveries"),"pending");});
  it("push global desativado preserva a geracao interna",async()=>{const u=await user(["entregador"]);await device(u);await run("UPDATE settings SET value='0' WHERE key='push_enabled'");await activity();let sends=0;await tick(async()=>{sends++;return 201;});assert.equal(sends,0);assert.equal(await scalar("SELECT COUNT(*) FROM user_notifications"),1);});
});
describe("revisoes, sincronizacao e lembretes",()=>{
  it("trocar responsavel invalida pendentes e direciona novos avisos",async()=>{const old=await user(["entregador"]);const next=await user(["entregador"]);await device(old);await device(next);const a=await activity("entrega",old);await tick();await run("UPDATE activities SET assignee_id=?,revision=revision+1 WHERE id=?",[next,a]);let sends=0;await tick(async()=>{sends++;return 201;});assert.equal(sends,1);const sent=await one<any>("SELECT s.user_id FROM push_deliveries d JOIN push_subscriptions s ON s.id=d.subscription_id WHERE d.status='sent'");assert.equal(sent.user_id,next);});
  it("cancelamento cancela lembrete antigo e gera aviso de cancelamento",async()=>{const u=await user(["entregador"]);await device(u);const a=await activity();await tick();await run("UPDATE activities SET status='cancelled',revision=revision+1 WHERE id=?",[a]);const messages:any[]=[];await tick(async(_s,p)=>{messages.push(p);return 201;});assert.equal(messages.length,1);assert.match(messages[0].title,/Cancelamento/);});
  it("reagendamento elimina horario antigo",async()=>{const u=await user(["entregador"]);await device(u);const a=await activity();await tick();await run("UPDATE activities SET scheduled_at=?,revision=revision+1 WHERE id=?",[local(NOW+10000),a]);await tick(async()=>201);assert.equal(await scalar("SELECT COUNT(*) FROM push_deliveries WHERE status='cancelled'"),1);});
  it("cron gera lembrete 1h antes usando fuso Sao Paulo sem navegador",async()=>{await user(["entregador"]);await activity("entrega",null,NOW+3600);await tick();assert.equal(await scalar("SELECT COUNT(*) FROM notification_events WHERE type='reminder' AND offset_minutes=60"),1);await tick();assert.equal(await scalar("SELECT COUNT(*) FROM notification_events WHERE type='reminder' AND offset_minutes=60"),1);});
  it("nao gera lembretes de atividade concluida",async()=>{await user(["entregador"]);const a=await activity("entrega",null,NOW);await run("UPDATE activities SET status='completed',revision=revision+1 WHERE id=?",[a]);await tick();assert.equal(await scalar("SELECT COUNT(*) FROM user_notifications"),0);});
  it("reserva gera separacao com os componentes fisicos existentes do kit",async()=>{const c=await montarCenario();const r=await criarReserva(c.clienteId,[{product_id:c.kitId,qty:2}]);assert.equal(await scalar("SELECT COUNT(*) FROM activities WHERE reservation_id=? AND kind='separacao'",[r]),1);assert.equal(await scalar("SELECT SUM(qty) FROM reservation_item_components WHERE reservation_id=? AND product_id=?",[r,c.cadeiraId]),8);await run("UPDATE reservations SET status='cancelada' WHERE id=?",[r]);assert.equal(await scalar("SELECT status FROM activities WHERE reservation_id=? AND kind='separacao'",[r]),"cancelled");});
  it("operacao sincroniza horario e atribuicao no mesmo write",async()=>{const u=await user();const op=await insert("INSERT INTO operations(kind,scheduled_at) VALUES ('entrega',?)",[local(NOW+3600)]);await run("UPDATE operations SET assignee_id=?,scheduled_at=? WHERE id=?",[u,local(NOW+7200),op]);const a=await one<any>("SELECT * FROM activities WHERE source='operations' AND source_id=?",[op]);assert.equal(a.assignee_id,u);assert.equal(a.scheduled_at,local(NOW+7200));assert.equal(a.revision,2);});
});

describe("diagnostico de falha de envio", () => {
  it("guarda o motivo sem vazar endpoint nem chave do aparelho", () => {
    const texto = sanitizeError(
      new TypeError("fetch failed for https://web.push.apple.com/QA-kWp1pSneGmxwNyySEGREDO"),
    );
    assert.match(texto, /TypeError/);
    assert.ok(!texto.includes("web.push.apple.com"), "endpoint nao pode aparecer");
    assert.ok(!texto.includes("SEGREDO"), "token nao pode aparecer");
    assert.match(texto, /\[endpoint\]/);
  });

  it("nao deixa a mensagem crescer sem limite", () => {
    assert.ok(sanitizeError(new Error("x".repeat(5000))).length <= 180);
  });

  it("aceita coisas que nao sao Error", () => {
    assert.equal(sanitizeError("quebrou"), "quebrou");
    assert.equal(sanitizeError(undefined), "undefined");
  });

  it("separa credencial recusada de queda de rede", () => {
    assert.match(explicaFalha(401, ""), /VAPID/i);
    assert.match(explicaFalha(403, ""), /VAPID/i);
    assert.match(explicaFalha(503, ""), /indisponível/i);
    assert.match(explicaFalha(429, ""), /ritmo/i);
    assert.match(explicaFalha(0, "TypeError: fetch failed"), /TypeError/);
    assert.match(explicaFalha(0, ""), /rede/i);
  });

  it("mensagem de erro nunca fica vazia", () => {
    assert.ok(explicaFalha(0, "").length > 0);
    assert.ok(sanitizeError(new Error("")).length > 0);
  });
});

describe("envio real ao servico de push", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  /** Par VAPID valido, no mesmo formato que scripts/setup-push.mjs grava. */
  function credenciais() {
    const ec = createECDH("prime256v1"); ec.generateKeys();
    return {
      publicKey: ec.getPublicKey().toString("base64url"),
      privateKey: ec.getPrivateKey().toString("base64url"),
      subject: "mailto:teste@exemplo.com",
    };
  }

  function inscricao() {
    const ec = createECDH("prime256v1"); ec.generateKeys();
    return {
      endpoint: "https://web.push.apple.com/QA-teste",
      keys: { p256dh: ec.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
    };
  }

  it("so usa opcao de redirect que o Workers implementa", async () => {
    // redirect:"error" nao existe na borda e lancava TypeError em todo envio,
    // o que aparecia como se fosse queda de rede
    let visto: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      visto = init;
      return new Response(null, { status: 201 });
    }) as typeof fetch;

    const status = await webPushSender(credenciais())(inscricao(), { id: 1, title: "t", body: "b", url: "/x" });
    assert.equal(status, 201);
    assert.ok(
      ["follow", "manual", undefined].includes(visto?.redirect as string),
      `redirect ${String(visto?.redirect)} nao e aceito no Workers`,
    );
  });

  it("nao segue redirect, para nao levar a credencial VAPID a outro host", async () => {
    let visto: RequestInit | undefined;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      visto = init;
      return new Response(null, { status: 301 });
    }) as typeof fetch;

    const status = await webPushSender(credenciais())(inscricao(), { id: 1, title: "t", body: "b", url: "/x" });
    assert.equal(visto?.redirect, "manual");
    assert.equal(status, 301, "o 3xx volta como falha normal, sem seguir");
  });

  it("recusa endpoint fora dos servicos conhecidos sem chamar a rede", async () => {
    let chamou = false;
    globalThis.fetch = (async () => { chamou = true; return new Response(null, { status: 201 }); }) as typeof fetch;
    const status = await webPushSender(credenciais())(
      { ...inscricao(), endpoint: "https://atacante.example.com/roubar" },
      { id: 1, title: "t", body: "b", url: "/x" },
    );
    assert.equal(status, 410);
    assert.equal(chamou, false, "nao pode sair requisicao para host desconhecido");
  });
});

describe("lembrete de adiantamento", () => {
  // a atividade de financial_entries agenda sempre para due_date+"T08:00"; para
  // o teste nao depender da hora real em que a suite roda, ancoramos "agora"
  // no proprio 08:00 de Brasilia de hoje, que e quando o offset=0 dispara
  const hojeBrasilia = local(NOW).slice(0, 10);
  const ancora = Math.floor(Date.parse(`${hojeBrasilia}T11:00:00Z`) / 1000);
  const amanhaBrasilia = local(NOW + 86400).slice(0, 10);

  async function cenarioAdiantamento(dueDate: string, extraOffsets = false) {
    const cliente = await insert(`INSERT INTO customers (name) VALUES ('Joao da Silva')`);
    const reserva = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, total_cents) VALUES ('LIMA-900',?,'confirmada','2026-10-10',100000)`,
      [cliente],
    );
    if (extraOffsets) await run(`UPDATE notification_rules SET offsets='[1440,60,0]' WHERE type='financeiro'`);
    await insert(
      `INSERT INTO financial_entries (number, direction, origin, customer_id, reservation_id, category, description, amount_cents, due_date, installment, installments_total)
       VALUES ('REC-900','receber','locacao',?,?,'Adiantamento','Adiantamento LIMA-900 - Joao da Silva',20000,?,1,1)`,
      [cliente, reserva, dueDate],
    );
    return { cliente, reserva };
  }

  it("no dia do vencimento, o aviso usa a voz amigavel pedida, nao o titulo generico", async () => {
    const op = await user(["financeiro"]);
    await device(op);
    await cenarioAdiantamento(hojeBrasilia);
    await tick(undefined, ancora);

    const aviso = await one<any>(`SELECT * FROM user_notifications ORDER BY id DESC LIMIT 1`);
    assert.match(aviso.body, /Opa! Hoje é dia de cobrar o adiantamento do cliente Joao da Silva/);
    assert.match(aviso.body, /R\$ 200,00/);
    assert.ok(!aviso.title.includes("Vencimento"), "nao pode sobrar o titulo generico");
  });

  it("um dia antes, avisa que o adiantamento se aproxima", async () => {
    const op = await user(["financeiro"]);
    await device(op);
    await cenarioAdiantamento(amanhaBrasilia, true);
    await tick(undefined, ancora);

    const aviso = await one<any>(`SELECT * FROM user_notifications WHERE body LIKE '%previsto%' LIMIT 1`);
    assert.ok(aviso, "o lembrete antecipado precisa existir");
    assert.match(aviso.body, /adiantamento de Joao da Silva.*R\$ 200,00.*previsto para amanhã/);
  });

  it("um lembrete de parcela comum (sem categoria Adiantamento) mantem a mensagem generica de sempre", async () => {
    const op = await user(["financeiro"]);
    await device(op);
    const cliente = await insert(`INSERT INTO customers (name) VALUES ('Maria')`);
    const reserva = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, total_cents) VALUES ('LIMA-901',?,'confirmada','2026-10-10',100000)`,
      [cliente],
    );
    await insert(
      `INSERT INTO financial_entries (number, direction, origin, customer_id, reservation_id, category, description, amount_cents, due_date, installment, installments_total)
       VALUES ('REC-901','receber','locacao',?,?,'Locacao','LIMA-901 1/2 - Maria',30000,?,1,2)`,
      [cliente, reserva, hojeBrasilia],
    );
    await tick(undefined, ancora);

    const aviso = await one<any>(`SELECT * FROM user_notifications ORDER BY id DESC LIMIT 1`);
    assert.match(aviso.title, /Vencimento/, "parcela comum continua com o titulo de sempre");
    assert.ok(!aviso.body.includes("Opa!"), "a voz do adiantamento nao vaza para outras parcelas");
  });
});
