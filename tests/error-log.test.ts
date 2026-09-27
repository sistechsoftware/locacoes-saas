import { beforeEach, afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1";
import { insert, run, scalar } from "../src/lib/db";
import {
  contarErros,
  marcarResolvido,
  mensagemDeErro,
  podarErrosAntigos,
  registrarErro,
  ultimosErros,
} from "../src/lib/error-log";
import { onRequestError } from "../src/instrumentation";
import { getUsuarioDaRequest } from "../src/lib/error-log-request";
import { rateLimit } from "../src/lib/rate-limit";

beforeEach(() => createTestDb());
afterEach(resetTestDb);

describe("diario de erros", () => {
  it("registra um erro de servidor com contexto completo", async () => {
    const id = await registrarErro({
      source: "onRequestError",
      kind: "server",
      message: "TypeError: x is not a function",
      route: "/reservas/123",
      method: "POST",
      digest: "abc123",
      userId: 7,
      userName: "Gezivaldo",
      context: { url: "/reservas/123", routeType: "action" },
    });
    assert.equal(typeof id, "number");
    const [row] = await ultimosErros("server");
    assert.equal(row.message, "TypeError: x is not a function");
    assert.equal(row.route, "/reservas/123");
    assert.equal(row.digest, "abc123");
    assert.equal(row.user_name, "Gezivaldo");
    assert.equal(row.resolved, 0);
    assert.ok(row.created_at > 0);
  });

  it("mensagemDeErro junta tipo, mensagem e causa, sem estourar tamanho", () => {
    const erro = new Error("falhou", { cause: new TypeError("campo ausente") });
    const msg = mensagemDeErro(erro);
    assert.ok(msg.startsWith("Error: falhou"));
    assert.ok(msg.includes("causa: TypeError: campo ausente"));
    const gigante = mensagemDeErro(new Error("x".repeat(9000)));
    assert.ok(gigante.length <= 4000);
  });

  it("registrarErro engole a propria falha e devolve null", async () => {
    // tabela inexistente: o INSERT quebra, mas a funcao resolve com null
    await run("DROP TABLE error_logs");
    const id = await registrarErro({
      source: "cron",
      kind: "server",
      message: "qualquer coisa",
    });
    assert.equal(id, null);
  });

  it("marcar como resolvido tira da contagem sem apagar o registro", async () => {
    const id = await registrarErro({ source: "cron", kind: "server", message: "e1" });
    assert.equal(await contarErros("server"), 1);
    await marcarResolvido(id!, true);
    assert.equal(await contarErros("server"), 0);
    const [row] = await ultimosErros("server");
    assert.equal(row.id, id);
    assert.equal(row.resolved, 1);
    await marcarResolvido(id!, false);
    assert.equal(await contarErros("server"), 1);
  });

  it("poda apenas o que passou de 30 dias", async () => {
    const idAntigo = await registrarErro({ source: "cron", kind: "server", message: "antigo" });
    await registrarErro({ source: "cron", kind: "server", message: "recente" });
    await run("UPDATE error_logs SET created_at = unixepoch() - 31*86400 WHERE id = ?", [idAntigo]);
    const db = (globalThis as any).__limasTestDb;
    const podados = await podarErrosAntigos(db);
    assert.equal(podados, 1);
    assert.equal(await scalar(`SELECT COUNT(*) FROM error_logs`), 1);
    const [row] = await ultimosErros("server");
    assert.equal(row.message, "recente");
  });

  it("onRequestError grava pagina, action e rota com o usuario da sessao", async () => {
    const userId = await insert("INSERT INTO users(name,username,password_hash,role) VALUES ('Ana','ana','x','admin')");
    const sessao = "sessao-teste-123";
    await insert("INSERT INTO sessions(id,user_id,expires_at) VALUES (?,?,datetime('now','+1 day'))", [
      sessao,
      userId,
    ]);
    const db = (globalThis as any).__limasTestDb;
    // a leitura de cookie usa o header bruto: injeta via getUsuarioDaRequest,
    // que e o caminho que o hook usa por dentro
    const usuario = await getUsuarioDaRequest({ cookie: `limas_session=${sessao}; other=1` });
    assert.deepEqual(usuario, { id: userId, name: "Ana" });

    await onRequestError(
      new Error("boom"),
      { path: "/reservas/9", method: "GET", headers: { cookie: `limas_session=${sessao}` } },
      { routerKind: "App Router", routePath: "/reservas/[id]", routeType: "render" },
    );
    const [row] = await ultimosErros("server");
    assert.equal(row.message, "Error: boom");
    assert.equal(row.route, "/reservas/[id]");
    assert.equal(row.method, "GET");
    assert.equal(row.user_id, userId);
    assert.equal(row.user_name, "Ana");
    assert.ok(String(row.context).includes("render"));
    void db;
  });

  it("erros do navegador entram na aba propria", async () => {
    await registrarErro({
      source: "api/log-erro",
      kind: "client",
      message: "ReferenceError: blip",
      route: null,
      context: { url: "/financeiro", userAgent: "Mozilla/5.0 (iPhone)" },
    });
    assert.equal(await contarErros("client"), 1);
    assert.equal(await contarErros("server"), 0);
    const [row] = await ultimosErros("client");
    assert.equal(row.source, "api/log-erro");
  });

  it("rate limit do endpoint de reporte bloqueia excesso", async () => {
    // mesmo bucket do route handler: 30 por janela de 300s
    let permitidos = 0;
    for (let i = 0; i < 35; i++) if (await rateLimit("log-erro", 30, 300)) permitidos++;
    assert.equal(permitidos, 30);
  });
});
