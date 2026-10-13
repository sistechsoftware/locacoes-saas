/**
 * Testes do scripts/db-backup.mjs — script do backup diário do D1.
 *
 * Rodam com um WRANGLER simulado (gravado em tmp) e um BACKUP_DIR isolado:
 * nada aqui toca `backups/` reais, o wrangler de verdade, o D1 ou o R2.
 *
 * Cobrem as causas da auditoria de 2026-10-12:
 *   - credencial ausente precisa falhar alto e cedo (antes de exportar);
 *   - upload SEM `--remote` (o bug que gravava no R2 simulado local e nunca
 *     chegava ao bucket remoto);
 *   - "sucesso" declarado sem objeto verificado no destino;
 *   - export incompleto/vazio considerado backup;
 *   - falha transitória x falha permanente (tentativas limitadas);
 *   - retenção local sem tocar em arquivos de outro prefixo;
 *   - workflow sem `continue-on-error` e com preflight de secrets.
 */
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(RAIZ, "scripts", "db-backup.mjs");
const WORKFLOW = path.join(RAIZ, ".github", "workflows", "backup-d1.yml");

/* ------------------------------ wrangler simulado ------------------------- */

const STUB = `
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const modo = process.env.STUB_MODE || "ok";
const log = process.env.STUB_LOG;
const store = process.env.STUB_STORE || ".";
if (log) appendFileSync(log, JSON.stringify(args) + "\\n");

const falhar = (msg) => { console.error("[stub] " + msg); process.exit(1); };
const conta = (chave) => {
  const f = path.join(store, "_count_" + chave);
  const n = existsSync(f) ? parseInt(readFileSync(f, "utf8"), 10) + 1 : 1;
  writeFileSync(f, String(n));
  return n;
};
const alvo = (caminho) => path.join(store, "obj_" + caminho.split("/").join("__"));

const SQL_OK = [
  "PRAGMA foreign_keys=OFF;",
  'CREATE TABLE "d1_migrations" (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);',
  'INSERT INTO "d1_migrations" VALUES (1,\\'0001_init.sql\\',\\'2026-01-01 00:00:00\\');',
  'CREATE TABLE "companies" (id TEXT PRIMARY KEY, nome TEXT);',
  'INSERT INTO "companies" VALUES (\\'c1\\',\\'Empresa teste\\');',
  "",
].join("\\n");

const cmd = args[0];
const sub = args[1];

if (cmd === "d1" && sub === "export") {
  if (modo === "auth") falhar("In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable for wrangler to work.");
  if (modo === "export-falha") falhar("[ERROR] export indisponivel");
  if (modo === "export-instavel" && conta("export") < 3) falhar("[ERROR] 502 transitorio");
  const out = args[args.indexOf("--output") + 1];
  const encher = (s) => s + "\\n" + "-- " + "x".repeat(200) + "\\n"; // acima do piso de 100 bytes
  if (modo === "export-vazio") { writeFileSync(out, "curto"); process.exit(0); }
  if (modo === "export-sem-create") { writeFileSync(out, encher('INSERT INTO "d1_migrations" VALUES (1); -- sem schema')); process.exit(0); }
  if (modo === "export-sem-migrations") { writeFileSync(out, encher("CREATE TABLE t (id INTEGER);\\nINSERT INTO t VALUES (1);")); process.exit(0); }
  writeFileSync(out, SQL_OK);
  process.exit(0);
}

if (cmd === "r2" && sub === "bucket") {
  const acao = args[2];
  if (acao === "info") {
    if (modo === "bucket-ausente" && conta("bucketinfo") === 1) falhar("NoSuchBucketError");
    process.exit(0);
  }
  if (acao === "create") { conta("bucketcreate"); process.exit(0); }
  falhar("comando r2 bucket desconhecido: " + acao);
}

if (cmd === "r2" && sub === "object") {
  const acao = args[2];
  const caminho = args[3];
  if (acao === "put") {
    // guarda de segurança do próprio stub: put sem --remote é o bug da auditoria
    if (!args.includes("--remote")) falhar("PUT sem --remote — gravaria no R2 local simulado");
    if (modo === "put-falha") falhar("[ERROR] 500 no upload");
    const file = args[args.indexOf("--file") + 1];
    mkdirSync(store, { recursive: true });
    copyFileSync(file, alvo(caminho));
    process.exit(0);
  }
  if (acao === "get") {
    if (!args.includes("--remote")) falhar("GET sem --remote");
    const out = args[args.indexOf("--file") + 1];
    if (modo === "get-ausente") falhar("The specified key does not exist.");
    const origem = alvo(caminho);
    if (!existsSync(origem)) falhar("The specified key does not exist.");
    if (modo === "get-corrupto") {
      const buf = readFileSync(origem);
      buf[0] = buf[0] === 65 ? 66 : 65; // mesmo tamanho, bytes diferentes
      writeFileSync(out, buf);
      process.exit(0);
    }
    copyFileSync(origem, out);
    process.exit(0);
  }
  falhar("comando r2 object desconhecido: " + acao);
}

falhar("comando desconhecido: " + args.join(" "));
`;

/* -------------------------------- utilidades ------------------------------ */

const raizTeste = mkdtempSync(path.join(tmpdir(), "db-backup-test-"));
const STUB_BIN = path.join(raizTeste, "wrangler-stub.mjs");
writeFileSync(STUB_BIN, STUB);

after(() => rmSync(raizTeste, { recursive: true, force: true }));

type Execucao = {
  status: number;
  stdout: string;
  stderr: string;
  saida: string;
  chamadas: string[][];
  backupDir: string;
  manifesto: string;
};

function executar(
  args: string[],
  env: Record<string, string> = {},
  antes?: (p: { backupDir: string; dir: string }) => void,
): Execucao {
  const dir = mkdtempSync(path.join(raizTeste, "run-"));
  const backupDir = path.join(dir, "backups");
  mkdirSync(backupDir, { recursive: true });
  mkdirSync(path.join(dir, "store"), { recursive: true });
  antes?.({ backupDir, dir });

  const log = path.join(dir, "stub.log");
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      WRANGLER_BIN: STUB_BIN,
      BACKUP_DIR: backupDir,
      BACKUP_ESPERA_MS: "0",
      BACKUP_TENTATIVAS: "3",
      STUB_MODE: "ok",
      STUB_LOG: log,
      STUB_STORE: path.join(dir, "store"),
      CLOUDFLARE_API_TOKEN: "token-de-teste",
      CLOUDFLARE_ACCOUNT_ID: "conta-de-teste",
      ...env,
    },
  });

  const chamadas: string[][] = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string[])
    : [];

  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    saida: (r.stdout ?? "") + (r.stderr ?? ""),
    chamadas,
    backupDir,
    manifesto: path.join(backupDir, "manifesto.log"),
  };
}

const linhasDoManifesto = (e: Execucao): string[] =>
  existsSync(e.manifesto)
    ? readFileSync(e.manifesto, "utf8").split("\n").filter(Boolean)
    : [];

const chamadasR2Objeto = (e: Execucao) =>
  e.chamadas.filter((c) => c[0] === "r2" && c[1] === "object");

/* --------------------------------- testes --------------------------------- */

describe("scripts/db-backup.mjs (wrangler simulado)", () => {
  it("caminho feliz: exporta, valida, assina, envia com --remote e verifica no destino", () => {
    const e = executar(["production"]);

    assert.equal(e.status, 0, `esperava exit 0, veio ${e.status}: ${e.saida}`);
    assert.match(e.saida, /Etapa 1\/5/);
    assert.match(e.saida, /Etapa 5\/5/);
    assert.match(e.saida, /verificado no R2 remoto/);
    assert.match(e.saida, /disponível para recuperação/);

    const linhas = linhasDoManifesto(e);
    assert.equal(linhas.length, 1, "manifesto deveria ter exatamente 1 linha");
    const [data, ambiente, status, tamanho, sha, nome, destino] = linhas[0].split(",");
    assert.equal(ambiente, "production");
    assert.equal(status, "ok");
    assert.ok(Number(tamanho) > 100);
    assert.match(sha, /^[0-9a-f]{64}$/);
    assert.match(nome, /^prod-\d{4}-\d{2}-\d{2}-\d{6}\.sql$/);
    assert.match(destino, /^r2:\/\/.+\/d1\/.+\.sql$/);

    // dump e sidecar existem e o checksum bate
    const dump = path.join(e.backupDir, nome);
    const hash = createHash("sha256").update(readFileSync(dump)).digest("hex");
    assert.equal(hash, sha);
    assert.equal(readFileSync(`${dump}.sha256`, "utf8"), `${sha}  ${nome}\n`);
  });

  it("todo put/get de objeto usa --remote (bug da auditoria: sem a flag ia pro R2 local)", () => {
    const e = executar(["staging"]);
    assert.equal(e.status, 0, e.saida);
    const objs = chamadasR2Objeto(e);
    assert.ok(objs.length >= 4, `esperava 2 puts + 2 gets, veio ${objs.length}`);
    for (const c of objs) {
      assert.ok(c.includes("--remote"), `chamada sem --remote: ${JSON.stringify(c)}`);
    }
    const exportsD1 = e.chamadas.filter((c) => c[0] === "d1" && c[1] === "export");
    assert.ok(exportsD1.length > 0);
    for (const c of exportsD1) assert.ok(c.includes("--remote"));
  });

  it("sem CLOUDFLARE_API_TOKEN falha cedo, sem chamar o wrangler e sem gerar arquivo", () => {
    const e = executar(["production"], { CLOUDFLARE_API_TOKEN: "" });
    assert.equal(e.status, 1);
    assert.match(e.saida, /CLOUDFLARE_API_TOKEN ausente/);
    assert.equal(e.chamadas.length, 0, "não deveria ter invocado o wrangler");
    assert.deepEqual(linhasDoManifesto(e), []);
  });

  it("falha de autenticação do wrangler reprova o backup e não registra manifesto", () => {
    const e = executar(["production"], { STUB_MODE: "auth" });
    assert.equal(e.status, 1);
    assert.match(e.saida, /necessary to set a CLOUDFLARE_API_TOKEN/);
    assert.match(e.saida, /falha no export do D1 após 3 tentativa\(s\)/);
    assert.deepEqual(linhasDoManifesto(e), []);
  });

  it("export incompleto é reprovado: arquivo vazio/curto, sem CREATE TABLE e sem d1_migrations", () => {
    for (const [modo, padrao] of [
      ["export-vazio", /backup suspeito: apenas \d+ bytes/],
      ["export-sem-create", /não contém CREATE TABLE/],
      ["export-sem-migrations", /sem a tabela d1_migrations/],
    ] as const) {
      const e = executar(["production"], { STUB_MODE: modo });
      assert.equal(e.status, 1, `modo ${modo} deveria falhar: ${e.saida}`);
      assert.match(e.saida, padrao);
      assert.deepEqual(linhasDoManifesto(e), [], `modo ${modo} não pode ir ao manifesto`);
    }
  });

  it("falha permanente no export não gera manifesto (só falha transitória é repetida)", () => {
    const e = executar(["production"], { STUB_MODE: "export-falha" });
    assert.equal(e.status, 1);
    const tentativasExport = e.chamadas.filter((c) => c[0] === "d1").length;
    assert.equal(tentativasExport, 3, `esperava 3 tentativas, houve ${tentativasExport}`);
    assert.deepEqual(linhasDoManifesto(e), []);
  });

  it("falha transitória no export se recupera nas tentativas limitadas", () => {
    const e = executar(["production"], { STUB_MODE: "export-instavel" });
    assert.equal(e.status, 0, e.saida);
    const tentativasExport = e.chamadas.filter((c) => c[0] === "d1").length;
    assert.equal(tentativasExport, 3);
    assert.match(e.saida, /recuperou na tentativa 3\/3/);
    assert.equal(linhasDoManifesto(e).length, 1);
  });

  it("falha no upload aborta antes do manifesto (cópia local segue íntegra)", () => {
    const e = executar(["production"], { STUB_MODE: "put-falha" });
    assert.equal(e.status, 1);
    assert.match(e.saida, /falha no upload para o R2 após 3 tentativa\(s\)/);
    assert.deepEqual(linhasDoManifesto(e), []);
    assert.ok(!e.saida.includes("disponível para recuperação"));
  });

  it("objeto que não chega ao R2 remoto reprova a verificação (sem falso sucesso)", () => {
    const e = executar(["production"], { STUB_MODE: "get-ausente" });
    assert.equal(e.status, 1);
    assert.match(e.saida, /não encontrado no R2 remoto|não está no R2 remoto/);
    assert.match(e.saida, /NÃO considere este backup armazenado/);
    assert.deepEqual(linhasDoManifesto(e), [], "manifesto só pode ser escrito após verificação");
  });

  it("objeto corrompido no destino é detectado pelo SHA-256", () => {
    const e = executar(["production"], { STUB_MODE: "get-corrupto" });
    assert.equal(e.status, 1);
    assert.match(e.saida, /tamanho remoto|SHA-256 remoto/);
    assert.deepEqual(linhasDoManifesto(e), []);
  });

  it("bucket remoto inexistente é criado e o backup continua", () => {
    const e = executar(["production"], { STUB_MODE: "bucket-ausente" });
    assert.equal(e.status, 0, e.saida);
    assert.match(e.saida, /não encontrado — criando/);
    assert.equal(linhasDoManifesto(e).length, 1);
  });

  it("modo --local dispensa credencial e não faz nenhum chamado de R2", () => {
    const e = executar(["staging", "--local"], { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" });
    assert.equal(e.status, 0, e.saida);
    assert.equal(chamadasR2Objeto(e).length, 0);
    for (const c of e.chamadas.filter((c) => c[0] === "d1")) assert.ok(c.includes("--local"));
    assert.match(linhasDoManifesto(e)[0], /,staging,ok,/);
  });

  it("retenção local poda dumps do próprio prefixo além dos 30 dias e preserva os demais", () => {
    const e = executar(["production"], {}, ({ backupDir }) => {
      const antigo = new Date(Date.now() - 45 * 86_400_000);
      for (const nome of ["prod-2020-01-01-000000.sql", "prod-2020-01-01-000000.sql.sha256", "staging-2020-01-01-000000.sql"]) {
        const p = path.join(backupDir, nome);
        writeFileSync(p, "conteudo antigo de teste");
        utimesSync(p, antigo, antigo);
      }
    });

    assert.equal(e.status, 0, e.saida);
    assert.ok(!existsSync(path.join(e.backupDir, "prod-2020-01-01-000000.sql")), "dump antigo do prefixo prod devia ser podado");
    assert.ok(!existsSync(path.join(e.backupDir, "prod-2020-01-01-000000.sql.sha256")), "sidecar antigo devia ser podado");
    assert.ok(existsSync(path.join(e.backupDir, "staging-2020-01-01-000000.sql")), "prefixo de outro ambiente não pode ser podado");
    assert.match(e.saida, /retenção local: 30 dias \(removidos 2 arquivo\(s\)/);
    assert.equal(linhasDoManifesto(e).length, 1);
  });

  it("nunca sobrescreve um arquivo de backup já existente (mesmo nome no mesmo segundo)", () => {
    const p2 = (n: number) => String(n).padStart(2, "0");
    const agora = new Date();
    const carimbo = `${agora.getFullYear()}-${p2(agora.getMonth() + 1)}-${p2(agora.getDate())}-${p2(agora.getHours())}${p2(agora.getMinutes())}${p2(agora.getSeconds())}`;
    const nomeSentinela = `prod-${carimbo}.sql`;

    const e = executar(["production"], {}, ({ backupDir }) => {
      writeFileSync(path.join(backupDir, nomeSentinela), "SENTINELA — backup que não pode ser sobrescrito");
      writeFileSync(path.join(backupDir, `${nomeSentinela}.sha256`), "sentinela\n");
    });

    // ou houve colisão (exit 1, sem tocar na sentinela) ou o relógio virou e
    // o script gerou outro nome — nos dois casos nada é sobrescrito
    if (e.status === 1) {
      assert.match(e.saida, /já existe/);
      assert.match(e.saida, /nada foi sobrescrito/);
      assert.deepEqual(linhasDoManifesto(e), []);
    } else {
      assert.equal(e.status, 0, e.saida);
    }
    const sentinela = path.join(e.backupDir, nomeSentinela);
    if (existsSync(sentinela)) {
      assert.equal(readFileSync(sentinela, "utf8"), "SENTINELA — backup que não pode ser sobrescrito");
    }
  });
});

describe(".github/workflows/backup-d1.yml", () => {
  const wf = parseYaml(readFileSync(WORKFLOW, "utf8")) as any;
  const passos = wf.jobs.backup.steps as any[];

  it("sintaxe YAML válida e agendamento diário preservado", () => {
    assert.equal(wf.on.schedule[0].cron, "0 3 * * *");
    assert.ok(wf.on.workflow_dispatch !== undefined, "workflow_dispatch precisa continuar disponível");
    assert.equal(wf.permissions.contents, "read");
    assert.equal(wf.jobs.backup["timeout-minutes"], 30);
  });

  it("não esconde falha: nenhum step com continue-on-error e nenhum || true", () => {
    for (const p of passos) {
      assert.ok(!("continue-on-error" in p), `step "${p.name}" não pode usar continue-on-error`);
      if (typeof p.run === "string") assert.ok(!p.run.includes("|| true"), `step "${p.name}" não pode engolir exit code`);
    }
  });

  it("tem preflight de secrets que falha quando eles não existem", () => {
    const pre = passos.find((p) => p.id === "secrets");
    assert.ok(pre, "passo de verificação de secrets ausente");
    assert.match(String(pre.run), /CLOUDFLARE_API_TOKEN/);
    assert.match(String(pre.run), /CLOUDFLARE_ACCOUNT_ID/);
    assert.match(String(pre.run), /exit 1/);
    assert.match(String(pre.run), /RUNBOOK-BACKUP-D1/);
  });

  it("staging roda mesmo quando produção falha, mas pula sem credencial", () => {
    const st = passos.find((p) => p.id === "backup_staging");
    assert.ok(st, "passo de staging ausente");
    assert.match(String(st.if), /!cancelled\(\)/);
    assert.match(String(st.if), /steps\.secrets\.outcome == 'success'/);
  });

  it("artefato do manifesto avisa quando ausente e há resumo de diagnóstico", () => {
    const art = passos.find((p) => String(p.uses || "").startsWith("actions/upload-artifact"));
    assert.ok(art, "upload-artifact ausente");
    assert.equal(art.with["if-no-files-found"], "warn");
    assert.equal(art.if, "always()");
    const resumo = passos.find((p) => p.name === "Resumo da execução (diagnóstico)");
    assert.ok(resumo, "resumo de diagnóstico ausente");
    assert.match(String(resumo.run), /GITHUB_STEP_SUMMARY/);
  });

  it("os dois backups recebem os secrets (sem expor valores)", () => {
    for (const id of ["backup_producao", "backup_staging"]) {
      const p = passos.find((s) => s.id === id);
      assert.ok(p, `passo ${id} ausente`);
      assert.equal(p.env.CLOUDFLARE_API_TOKEN, "${{ secrets.CLOUDFLARE_API_TOKEN }}");
      assert.equal(p.env.CLOUDFLARE_ACCOUNT_ID, "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}");
    }
  });
});
