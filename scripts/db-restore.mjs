#!/usr/bin/env node
/**
 * Restore do D1 a partir de um dump gerado por scripts/db-backup.mjs
 * (pendência #09). Nunca roda em produção sem confirmação digitada na tela.
 *
 * Uso:
 *   node scripts/db-restore.mjs staging    --arquivo backups/staging-2026-10-09-120000.sql
 *   node scripts/db-restore.mjs production --arquivo backups/prod-2026-10-09-120000.sql
 *   node scripts/db-restore.mjs staging    --arquivo <dump> --local   # D1 local (teste)
 *
 * Flags:
 *   --arquivo <caminho>   dump .sql a restaurar (obrigatório; aceita .sha256 junto)
 *   --local               opera no D1 local usado pelo `wrangler dev` (testes)
 *   --sim                 não perguntar confirmação (staging/local apenas)
 *   --sem-r2              pula o backup prévio do R2 (só aceito com --local)
 *   --sem-backup-previo   pula o backup prévio (só aceito com --local)
 *
 * ORDEM DAS OPERAÇÕES (por que não basta "importar o dump"):
 *   O export do D1 intercala schema e dados na ordem de criação original e o
 *   schema tem FK para frente (payments é criada ANTES de financial_accounts;
 *   dados de `sessions` vêm na linha 48 e `users` na linha 1034). O D1 impõe
 *   foreign key IMEDIATA em produção — pragma foreign_keys=OFF não é honrado
 *   no import remoto (medido: sonda zz_c/zz_d) — então o dump cru falha.
 *   E há ciclo de FK no schema (users ↔ companies etc.), então ordem
 *   topológica de TABELAS também não basta. Este script:
 *     1. DROPs em ordem topológica (filhas antes das mães) — segurança com
 *        FK ligada; o dump usa CREATE TABLE IF NOT EXISTS, então tem que
 *        apagar antes (senão duplica linhas e mantém schema antigo);
 *     2. schema primeiro (todos os CREATE TABLE antes de qualquer INSERT);
 *     3. INSERTs reordenados por LINHA: dependência calculada a partir dos
 *        VALORES de FK de cada linha contra a chave do pai (a carga original
 *        do banco é sempre factível — o D1 já validava tudo ao vivo), o que
 *        resolve ciclos de schema sem depender de pragma;
 *     4. GATE: o arquivo final inteiro roda num SQLite em memória COM FK
 *        LIGADA antes de qualquer operação no banco alvo — se a ordem estiver
 *        errada em algo, aborta aqui, sem tocar em nada;
 *     5. statements maiores que ~90KB são quebrados (INSERT + UPDATEs em
 *        blocos de 40KB; blobs viram hex em texto + unhex() final — `||` do
 *        D1 derruba bytes não-UTF8): o D1 rejeita statement grande com
 *        SQLITE_TOOBIG — e o wrangler só mostra `D1_RESET_DO`, sem dizer onde;
 *     6. backup prévio do alvo (rollback point) — obrigatório no remoto;
 *     7. executa tudo em um único `wrangler d1 execute --file` (o D1
 *        rollbacka sozinho para o último estado bom se falhar);
 *     8. verifica: conjunto de tabelas, contagem de linhas por tabela (contra
 *        o que o dump declara) e PRAGMA integrity_check (quando o D1 deixa).
 *
 * Produção: exige terminal interativo e a frase digitada "RESTAURAR PRODUCAO".
 * Não existe flag para contornar isso — automação não restaura produção.
 *
 * Sai com 0 só se a verificação passar; 1 em qualquer falha.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(RAIZ, "node_modules", "wrangler", "bin", "wrangler.js");
const DIR_BACKUPS = path.join(RAIZ, "backups");

const AMBIENTES = {
  production: { db: "limas-saas-db", env: "production", prefixo: "prod", migrar: "npm run db:migrate" },
  staging: { db: "limas-saas-staging-db", env: "staging", prefixo: "staging", migrar: "npm run db:migrate:staging" },
};

const ok = (m) => console.log(`  ✔ ${m}`);
const aviso = (m) => console.log(`  ⚠ ${m}`);
const falhar = (m) => {
  console.error(`  ✖ ${m}`);
  process.exit(1);
};

/* ------------------------------- args ---------------------------------- */

const args = process.argv.slice(2).filter((a) => a !== "--");
const valorDe = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const tem = (flag) => args.includes(flag);

const ajuda = tem("--ajuda") || tem("--help");
if (ajuda) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0] + "*/");
  process.exit(0);
}

const ambiente = args.find((a) => !a.startsWith("--") && a !== valorDe("--arquivo"));
const arquivo = valorDe("--arquivo");
const local = tem("--local");
const sim = tem("--sim");
const semR2 = tem("--sem-r2");
const semBackupPrevio = tem("--sem-backup-previo");

if (!ambiente || !AMBIENTES[ambiente] || !arquivo) {
  console.error("Uso: node scripts/db-restore.mjs <staging|production> --arquivo backups/<dump>.sql [--local] [--sim]");
  process.exit(2);
}
if ((semR2 || semBackupPrevio) && !local) falhar("--sem-r2/--sem-backup-previo só são permitidos com --local");
if (sim && ambiente === "production" && !local) {
  falhar("--sim não é aceito em produção: a confirmação é manual e digitada");
}

const cfg = AMBIENTES[ambiente];
const remoto = local ? "--local" : "--remote";

/** Roda o wrangler do projeto (node_modules). */
function wrangler(cmdArgs) {
  const r = spawnSync(process.execPath, [WRANGLER, ...cmdArgs], { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function wranglerOuFalha(cmdArgs, contexto) {
  const r = wrangler(cmdArgs);
  if (r.status !== 0) {
    console.error(r.stdout);
    console.error(r.stderr);
    falhar(`${contexto} (wrangler saiu com ${r.status})`);
  }
  return r;
}
/** `d1 execute --json` devolve JSON (às vezes entre avisos) — extrai o primeiro array. */
function parseJson(saida) {
  const direto = saida.trim();
  try { return JSON.parse(direto); } catch { /* segue */ }
  const ini = saida.indexOf("[");
  const fim = saida.lastIndexOf("]");
  if (ini >= 0 && fim > ini) return JSON.parse(saida.slice(ini, fim + 1));
  throw new Error("saída --json não reconhecida");
}
/** Resultados da primeira query de um `d1 execute --json`. */
function resultados(r) {
  const out = parseJson(r.stdout);
  const bloco = Array.isArray(out) ? out[0] : out;
  return bloco?.results ?? [];
}
const aspas = (n) => `"${String(n).replace(/"/g, '""')}"`;
/** Tabelas internas do SQLite/D1: fora de inventário, drop e comparação
 * (COUNT(*) em `_cf_METADATA` devolve SQLITE_AUTH e o dump não a exporta). */
const ehInterna = (nome) => nome.startsWith("sqlite_") || nome.startsWith("_cf_");

/* ---------------------------- dump: expectativas ------------------------ */

const dumpPath = path.resolve(RAIZ, arquivo);
if (!existsSync(dumpPath)) falhar(`arquivo não encontrado: ${arquivo}`);
const dumpBytes = readFileSync(dumpPath);
if (dumpBytes.length < 100) falhar("dump pequeno demais para ser válido");

const sidecar = `${dumpPath}.sha256`;
if (existsSync(sidecar)) {
  const esperado = readFileSync(sidecar, "utf8").trim().split(/\s+/)[0];
  const real = createHash("sha256").update(dumpBytes).digest("hex");
  if (esperado !== real) falhar(`checksum divergente: esperado ${esperado}, calculado ${real}`);
  ok(`checksum .sha256 confere (${real.slice(0, 16)}…)`);
} else {
  aviso("sem .sha256 junto do dump — integrity check por hash pulado");
}

const dump = dumpBytes.toString("utf8");
if (!/CREATE TABLE/i.test(dump)) falhar("dump sem CREATE TABLE");

/* --------------------------- statements --------------------------------- */

/**
 * Divide SQL em statements: final de linha com `;` fora de string e fora de
 * bloco BEGIN...END de trigger. (O dump tem 50 triggers cujos bodies contêm
 * `;` — separar por linha ingênua parte o arquivo no meio.)
 */
function separarStatements(texto) {
  const linhas = texto.split(/\r?\n/);
  const out = [];
  let buffer = [];
  let inicio = 0;
  let emString = false;
  let emTrigger = false;
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    if (buffer.length === 0) {
      inicio = i + 1;
      emString = false;
    }
    buffer.push(linha);
    if (!emTrigger && /^\s*CREATE\s+TRIGGER/i.test(linha)) emTrigger = true;
    for (const ch of linha) {
      if (ch === "'") emString = !emString;
    }
    if (emTrigger) {
      if (!emString && /^\s*END;\s*$/i.test(linha)) {
        out.push({ linha: inicio, sql: buffer.join("\n") });
        buffer = [];
        emTrigger = false;
      }
      continue;
    }
    if (!emString && /;\s*$/.test(linha)) {
      out.push({ linha: inicio, sql: buffer.join("\n") });
      buffer = [];
    }
  }
  if (buffer.join("").trim()) out.push({ linha: inicio, sql: buffer.join("\n") });
  return out;
}

/** Divide texto por separador fora de aspas e parênteses. */
function dividirTopo(texto, sep = ",") {
  const partes = [];
  let atual = "";
  let aspa = null;
  let prof = 0;
  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (aspa) {
      atual += ch;
      if (ch === aspa) {
        if (texto[i + 1] === aspa) {
          atual += texto[++i];
        } else {
          aspa = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      aspa = ch;
      atual += ch;
      continue;
    }
    if (ch === "(") prof++;
    if (ch === ")") prof--;
    if (ch === sep && prof === 0) {
      partes.push(atual);
      atual = "";
      continue;
    }
    atual += ch;
  }
  if (atual.trim()) partes.push(atual);
  return partes;
}

/** Tabelas que o dump declara criar. */
const tabelasEsperadas = new Set();
for (const m of dump.matchAll(/CREATE TABLE (?:IF NOT EXISTS )*(?:"([^"]+)"|([A-Za-z_][\w$]*))/g)) {
  tabelasEsperadas.add(m[1] ?? m[2]);
}
/**
 * Linhas esperadas por tabela (o export do D1 gera 1 INSERT por linha).
 * IMPORTANTE: bodies de TRIGGER também contêm linhas começando com
 * `INSERT INTO ...` — sem filtrar, a expectativa de `activities` saía 10
 * enquanto a tabela estava vazia no origem (o INSERT vinha do trigger).
 */
const linhasEsperadas = new Map();
const stmtsDump = separarStatements(dump);
for (const st of stmtsDump) {
  if (/^\s*CREATE\s+(TRIGGER|VIEW)/i.test(st.sql)) continue;
  const m = st.sql.match(/^\s*INSERT\s+INTO\s+(?:"([^"]+)"|([A-Za-z_]\w*))/i);
  if (!m) continue;
  const t = m[1] ?? m[2];
  linhasEsperadas.set(t, (linhasEsperadas.get(t) ?? 0) + 1);
}
if (tabelasEsperadas.size === 0) falhar("não consegui ler as tabelas do dump");
ok(`dump: ${tabelasEsperadas.size} tabela(s), ${[...linhasEsperadas.values()].reduce((a, b) => a + b, 0)} linha(s) de dados`);

/* ------------------------------ montagem -------------------------------- */

/** Referências de FK por tabela, lidas dos CREATE TABLE (para os DROPs). */
function refsDasTabelas(schema, stmtsEsquema) {
  const refs = new Map(schema.filter((s) => s.type === "table").map((s) => [s.name, new Set()]));
  for (const st of stmtsEsquema) {
    const m = st.sql.match(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_]\w*)"?/i);
    if (!m) continue;
    if (!refs.has(m[1])) refs.set(m[1], new Set());
    for (const r of st.sql.matchAll(/\bREFERENCES\s+"?([A-Za-z_]\w*)"?/g)) refs.get(m[1]).add(r[1]);
  }
  return refs;
}

/** FK completas (coluna → pai.coluna) por tabela, para a ordenação por linha. */
function extrairFks(stmtsEsquema) {
  const mapa = new Map();
  for (const st of stmtsEsquema) {
    const m = st.sql.match(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z_]\w*)"?/i);
    if (!m) continue;
    const tabela = m[1];
    const ini = st.sql.indexOf("(");
    const fim = st.sql.lastIndexOf(")");
    if (ini < 0 || fim < ini) continue;
    const fks = [];
    for (const bruto of dividirTopo(st.sql.slice(ini + 1, fim))) {
      const parte = bruto.trim();
      if (!parte) continue;
      const fkTabela = parte.match(/^FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+"?([A-Za-z_]\w*)"?\s*\(([^)]*)\)/i);
      if (fkTabela) {
        const cols = fkTabela[1].split(",").map((s) => s.trim().replace(/"/g, ""));
        const pcols = fkTabela[3].split(",").map((s) => s.trim().replace(/"/g, ""));
        cols.forEach((c, i) => fks.push({ col: c, pai: fkTabela[2], paiCol: pcols[i] ?? pcols[0] }));
        continue;
      }
      if (/^FOREIGN\s+KEY/i.test(parte)) continue;
      const inline = parte.match(/^"?([A-Za-z_]\w*)"?\s+[\s\S]*?\bREFERENCES\s+"?([A-Za-z_]\w*)"?\s*(?:\(\s*"?([A-Za-z_]\w*)"?\s*\))?/i);
      if (inline) fks.push({ col: inline[1], pai: inline[2], paiCol: inline[3] ?? "id" });
    }
    if (fks.length) mapa.set(tabela, fks);
  }
  return mapa;
}

/** Lê um INSERT (1 por linha no export): tabela, colunas, valores normalizados e brutos. */
function lerInsert(st) {
  const m = st.sql.match(/^\s*INSERT\s+INTO\s+(?:"([^"]+)"|([A-Za-z_]\w*))\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\)\s*;?\s*$/i);
  if (!m) return null;
  const tabela = m[1] ?? m[2];
  const cols = dividirTopo(m[3]).map((c) => c.trim().replace(/"/g, ""));
  const brutos = dividirTopo(m[4]).map((v) => v.trim());
  if (cols.length !== brutos.length) return null;
  const mapa = new Map();
  cols.forEach((c, i) => {
    const t = brutos[i];
    let v = null;
    if (/^null$/i.test(t)) v = null;
    else if (t.startsWith("'") && t.endsWith("'")) v = t.slice(1, -1).replace(/''/g, "'");
    else v = t;
    mapa.set(c, v);
  });
  return { tabela, cols, brutos, mapa };
}

/**
 * D1 rejeita statement maior que ~100KB (SQLITE_TOOBIG — medido: um INSERT
 * de `files` com 264KB derrubava o import inteiro com D1_RESET_DO, erro que
 * o wrangler não detalha). Valores gigantes são extraídos para '' no INSERT
 * e montados de volta com UPDATEs em blocos de 40KB (`col = col || 'pedaço'`),
 * emitidos imediatamente após o INSERT para a linha ficar completa na hora.
 */
function quebrarValores(st, info) {
  const LIMITE = 90 * 1024;
  const PEDACO = 40 * 1024;
  if (st.sql.length <= LIMITE) return { sql: st.sql, extras: [] };
  const { tabela, cols, brutos } = info;
  const substituidos = [...brutos];
  const extras = [];
  let quebrou = false;
  brutos.forEach((bruto, i) => {
    if (bruto.length <= PEDACO) return;
    const ehHex = /^X'[\s\S]*'$/i.test(bruto);
    const ehString = bruto.startsWith("'") && bruto.endsWith("'");
    if (!ehHex && !ehString) {
      falhar(`statement de ${st.sql.length} bytes com valor gigante não-string em ${tabela}.${cols[i]} — não sei quebrar`);
    }
    const conteudo = ehHex ? bruto.slice(2, -1) : bruto.slice(1, -1).replace(/''/g, "'");
    if (ehHex && conteudo.length % 2 !== 0) falhar(`hex blob ímpar em ${tabela}.${cols[i]} — não sei quebrar`);
    const pedacos = [];
    for (let p = 0; p < conteudo.length; p += PEDACO) pedacos.push(conteudo.slice(p, p + PEDACO));
    if (ehHex) {
      // BLOB: `||` do D1 converte blob para texto e DERRUBA bytes não-UTF8
      // (medido: 8 bytes viravam 4). Então monta como TEXTO hex (concat de
      // ASCII é seguro) e converte com unhex() no final.
      substituidos[i] = "''";
      pedacos.forEach((pedaco, k) => {
        extras.push(k === 0
          ? `UPDATE ${aspas(tabela)} SET ${aspas(cols[i])} = '${pedaco}';`
          : `UPDATE ${aspas(tabela)} SET ${aspas(cols[i])} = ${aspas(cols[i])} || '${pedaco}';`);
      });
      extras.push(`UPDATE ${aspas(tabela)} SET ${aspas(cols[i])} = unhex(${aspas(cols[i])});`);
    } else {
      substituidos[i] = "''";
      pedacos.forEach((pedaco, k) => {
        const esc = pedaco.replace(/'/g, "''");
        extras.push(k === 0
          ? `UPDATE ${aspas(tabela)} SET ${aspas(cols[i])} = '${esc}';`
          : `UPDATE ${aspas(tabela)} SET ${aspas(cols[i])} = ${aspas(cols[i])} || '${esc}';`);
      });
    }
    quebrou = true;
  });
  if (!quebrou) falhar(`statement de ${st.sql.length} bytes sem valor único gigante em ${tabela} — não sei quebrar`);
  const sql = `INSERT INTO ${aspas(tabela)} (${cols.map(aspas).join(",")}) VALUES(${substituidos.join(",")});`;
  if (sql.length > LIMITE) falhar(`INSERT de ${tabela} continua com ${sql.length} bytes mesmo após a quebra`);
  return { sql, extras };
}

/**
 * INSERTs em ordem SEGURA para foreign_keys IMEDIATA: dependência por LINHA —
 * o INSERT de uma linha só sai depois do INSERT da linha pai que ela referencia
 * (valor do campo de FK → chave do pai). Padrão do export: 1 INSERT por linha,
 * então dá para intercalar linhas de tabelas em ciclo (users ↔ companies) sem
 * pragma nenhum. Ordem original é preservada entre linhas independentes.
 */
function ordenarDadosPorLinha(inserts, fks) {
  // índice de chaves: "tabela.coluna" → valor → índice do statement
  const chaves = new Map();
  inserts.forEach((st, i) => {
    if (!st.info) return;
    for (const [col, val] of st.info.mapa) {
      if (val === null) continue;
      const k = `${st.info.tabela}.${col}`;
      if (!chaves.has(k)) chaves.set(k, new Map());
      const idx = chaves.get(k);
      if (!idx.has(val)) idx.set(val, i);
    }
  });
  // dependências: i precisa do pai (deps[i] = índices que precisam vir antes)
  const deps = inserts.map(() => new Set());
  inserts.forEach((st, i) => {
    if (!st.info) return;
    for (const fk of fks.get(st.info.tabela) ?? []) {
      const val = st.info.mapa.get(fk.col);
      if (val === null || val === undefined) continue;
      const paiIdx = chaves.get(`${fk.pai}.${fk.paiCol}`)?.get(val);
      if (paiIdx !== undefined && paiIdx !== i) deps[i].add(paiIdx);
    }
  });
  // Kahn estável (sempre emite o mais antigo pronto — mantém a ordem original)
  const emitido = new Array(inserts.length).fill(false);
  const saida = [];
  let restantes = inserts.length;
  while (restantes > 0) {
    let prog = true;
    while (prog) {
      prog = false;
      for (let i = 0; i < inserts.length; i++) {
        if (emitido[i] || ![...deps[i]].every((p) => emitido[p])) continue;
        emitido[i] = true;
        saida.push(inserts[i]);
        restantes--;
        prog = true;
      }
    }
    if (restantes > 0) {
      const i = emitido.findIndex((e) => !e);
      falhar(
        `ciclo de dados de FK em ${inserts[i].info?.tabela ?? "?"} — carga impossível com FK imediata ` +
        `(o dump está inconsistente ou o parser de FK cobriu algo que o SQLite exige)`,
      );
    }
  }
  return saida;
}

/**
 * DROPs em ordem SEGURA com foreign_keys=ON: apagar um PAI antes dos filhos
 * que o referenciam dá "no such table" (reproduzido: financial_accounts antes
 * de payments). A ordem de criação inversa não basta porque o schema tem
 * referências para frente. Então: triggers → views → tabelas em ordem
 * topológica (que ninguém mais referencia sai primeiro = filhas antes).
 */
function ordenarDrops(schema, refs) {
  const triggers = schema.filter((s) => s.type === "trigger").map((s) => `DROP TRIGGER IF EXISTS ${aspas(s.name)};`);
  const views = schema.filter((s) => s.type === "view").map((s) => `DROP VIEW IF EXISTS ${aspas(s.name)};`);
  const tabelas = schema.filter((s) => s.type === "table").map((s) => s.name);
  const pendentes = new Set(tabelas);
  const ordem = [];
  while (pendentes.size) {
    const prontas = [...pendentes].filter((t) => ![...pendentes].some((o) => o !== t && refs.get(o)?.has(t)));
    if (prontas.length === 0) {
      ordem.push(...pendentes); // ciclo de FK — ordem residual
      break;
    }
    for (const t of prontas) {
      ordem.push(t);
      pendentes.delete(t);
    }
  }
  return [...triggers, ...views, ...ordem.map((t) => `DROP TABLE IF EXISTS ${aspas(t)};`)];
}

/**
 * Monta o arquivo de restore: pragmas + drops + schema primeiro + dados
 * reordenados por linha + DDL (indexes/triggers/views) no fim.
 */
function montarRestaurador(dumpTexto, schema) {
  const stmts = separarStatements(dumpTexto).filter((s) => !/^\s*PRAGMA\b/i.test(s.sql));
  if (stmts.length < 10) falhar("dump separado em pouquíssimos statements — dump suspenso");
  const esquema = stmts.filter((s) => /^\s*CREATE\s+TABLE/i.test(s.sql));
  const resto = stmts.filter((s) => !/^\s*CREATE\s+TABLE/i.test(s.sql));

  const refs = refsDasTabelas(schema, esquema);
  const drops = ordenarDrops(schema, refs);

  const fks = extrairFks(esquema);
  const ehInsert = /^\s*INSERT\s+INTO/i;
  const ehSeq = /^\s*INSERT\s+INTO\s+"?sqlite_/i;
  const dadosBrutos = resto.filter((s) => ehInsert.test(s.sql) && !ehSeq.test(s.sql));
  const sequencia = resto.filter((s) => ehSeq.test(s.sql));
  const ddl = resto.filter((s) => !ehInsert.test(s.sql));
  const inserts = dadosBrutos.map((st) => ({ ...st, info: lerInsert(st) }));
  const semInfo = inserts.filter((st) => !st.info);
  if (semInfo.length) falhar(`não consegui parsear ${semInfo.length} INSERT(s), ex.: ${semInfo[0].sql.slice(0, 120)}`);
  // statements >90KB (SQLITE_TOOBIG no D1) viram INSERT + UPDATEs em blocos
  let quebrados = 0;
  for (const st of inserts) {
    const antes = st.sql.length;
    const b = quebrarValores(st, st.info);
    st.sql = b.sql;
    st.extras = b.extras;
    if (antes !== b.sql.length) quebrados++;
  }
  const dados = ordenarDadosPorLinha(inserts, fks);

  // pragma só como redunância (o D1 remoto pode não honrar) — a ordem acima
  // é que garante a carga; OFF no topo, religada no fim.
  const partes = ["PRAGMA foreign_keys=OFF;", "PRAGMA defer_foreign_keys=TRUE;", ...drops];
  for (const s of [...esquema, ...dados, ...sequencia, ...ddl]) {
    partes.push(s.sql);
    if (s.extras?.length) partes.push(...s.extras);
  }
  partes.push("PRAGMA foreign_keys=ON;");

  return {
    sql: partes.join("\n\n"),
    drops: drops.length,
    tabelas: esquema.length,
    insercoes: dados.length,
    quebrados,
    statements: partes.length,
  };
}

/**
 * GATE: roda o arquivo FINAL num SQLite em memória ANTES de tocar no alvo,
 * em 3 fases, para cobrir os dois riscos medidos:
 *   1/3 schema+dados do ZERO com foreign_keys=ON e SEM pragma (o pior caso
 *      do import remoto, que não honra foreign_keys=OFF) — valida a ordem
 *      por linha;
 *   2/3 drops sobre banco POPULADO com os pragmas do próprio arquivo (é
 *      assim que executam de verdade) — valida a ordem de drop;
 *   3/3 o arquivo completo tal qual será enviado, do zero (sanidade final).
 * Qualquer erro aborta ANTES de qualquer operação no banco alvo.
 */
async function simular(sqlFinal) {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    falhar("node:sqlite indisponível — use Node.js >= 22 (o gate de simulação do restore exige)");
  }
  const stmts = separarStatements(sqlFinal);
  const semPragmas = stmts.filter((s) => !/^\s*PRAGMA/i.test(s.sql));
  const soDados = semPragmas.filter((s) => !/^\s*DROP/i.test(s.sql));
  const pragmasEDrops = stmts.filter((s) => /^\s*(PRAGMA|DROP)/i.test(s.sql));

  const novo = () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    return db;
  };
  const executar = (db, lista, fase) => {
    for (const s of lista) {
      try {
        db.exec(s.sql);
      } catch (e) {
        console.error(`  ✖ simulação ${fase} falhou na linha ${s.linha}: ${e.message}`);
        console.error(s.sql.split("\n").slice(0, 5).join("\n").slice(0, 400));
        falhar("gate de simulação reprovado — nada foi alterado no banco alvo");
      }
    }
  };

  const dbA = novo();
  executar(dbA, soDados, "1/3 (schema+dados do zero, FK ligada, sem pragma)");
  executar(dbA, pragmasEDrops, "2/3 (drops com os pragmas, sobre banco populado)");
  dbA.close();

  const dbB = novo();
  executar(dbB, stmts, "3/3 (arquivo completo, do zero)");
  dbB.close();
}

/* ---------------------------- banco alvo -------------------------------- */

/** Inventário do banco alvo: tabelas + contagem de linhas em uma única query. */
async function inventario() {
  const q1 = wrangler(["d1", "execute", cfg.db, remoto, "--env", cfg.env,
    "--command",
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`,
    "--json", "-y"]);
  if (q1.status !== 0) {
    console.error(q1.stderr || q1.stdout);
    falhar("não consegui listar as tabelas do banco alvo");
  }
  const tabelas = resultados(q1).map((r) => r.name);
  if (tabelas.length === 0) return { tabelas: [], contagens: new Map() };
  const colunas = tabelas.map((t, i) => `(SELECT COUNT(*) FROM ${aspas(t)}) AS c${i}`);
  const q2 = wrangler(["d1", "execute", cfg.db, remoto, "--env", cfg.env,
    "--command", `SELECT ${colunas.join(", ")}`, "--json", "-y"]);
  if (q2.status !== 0) {
    console.error(q2.stderr || q2.stdout);
    falhar("não consegui contar as linhas do banco alvo");
  }
  const linha = resultados(q2)[0] ?? {};
  const contagens = new Map(tabelas.map((t, i) => [t, Number(linha[`c${i}`] ?? 0)]));
  return { tabelas, contagens };
}

/** Schema atual do alvo, para montar os DROPs. */
function schemaAtual() {
  const r = wrangler(["d1", "execute", cfg.db, remoto, "--env", cfg.env,
    "--command",
    `SELECT type, name, sql, rowid AS ordem FROM sqlite_master
      WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND type IN ('table','view','trigger')
      ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 ELSE 2 END, ordem DESC`,
    "--json", "-y"]);
  if (r.status !== 0) {
    console.error(r.stderr || r.stdout);
    falhar("não consegui ler o schema atual do banco alvo");
  }
  return resultados(r);
}

/* --------------------------- confirmação -------------------------------- */

function confirmar() {
  if (ambiente === "production" && !local) {
    if (!process.stdin.isTTY) {
      falhar("restore de produção exige terminal interativo (não rode via script/CI)");
    }
    console.log("\n⚠⚠⚠  RESTAURAR PRODUÇÃO SUBSTITUI TODOS OS DADOS DE TODOS OS CLIENTES  ⚠⚠⚠");
    console.log(`Banco: ${cfg.db} | Dump: ${arquivo}`);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question('Digite "RESTAURAR PRODUCAO" para confirmar (ou vazio para abortar): ', (resposta) => {
        rl.close();
        resolve(resposta.trim() === "RESTAURAR PRODUCAO");
      });
    });
  }
  if (sim) return Promise.resolve(true);
  if (!process.stdin.isTTY) return Promise.resolve(true); // staging em CI
  console.log(`\n⚠ Isso APAGA o schema atual de ${cfg.db} (${ambiente}) e regrava o dump.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('Confirma? Digite "restaurar" para prosseguir: ', (resposta) => {
      rl.close();
      resolve(resposta.trim().toLowerCase() === "restaurar");
    });
  });
}

/* -------------------------------- main ---------------------------------- */

const confirmado = await confirmar();
if (!confirmado) {
  console.log("Abortado pelo operador — nada foi alterado.");
  process.exit(1);
}

console.log(`\n▸ Restore de ${ambiente} ← ${arquivo}`);

// 1) lê o schema atual (para os drops) e monta o arquivo
const schema = schemaAtual();
const montado = montarRestaurador(dump, schema);
console.log(`  … arquivo: ${montado.drops} DROP(s) + ${montado.tabelas} tabela(s) primeiro + ${montado.insercoes} INSERT(s) reordenados por linha${montado.quebrados ? ` (${montado.quebrados} statement(s) gigantes quebrados em blocos <90KB)` : ""} (${montado.statements} statements)`);

// 2) GATE: simula tudo num SQLite em memória com FK ligada — sem tocar no alvo
console.log("  … simulando o arquivo (3 fases) — gate antes de tocar no alvo");
await simular(montado.sql);
ok("simulação passou: schema+dados com FK ligada, drops populados e arquivo completo");

// 3) inventário do que existe hoje (para o relatório e o diagnóstico)
const antes = await inventario();
console.log(`  … alvo atual: ${antes.tabelas.length} tabela(s), ${[...antes.contagens.values()].reduce((a, b) => a + b, 0)} linha(s)`);

// 4) rollback point: backup do alvo antes de mexer (obrigatório no remoto)
if (!semBackupPrevio) {
  console.log("  … backup prévio do alvo (rollback point)");
  const backupArgs = [path.join(RAIZ, "scripts", "db-backup.mjs"), ambiente, "--rotulo", "pre-restore"];
  if (local) backupArgs.push("--local", "--sem-r2");
  const b = spawnSync(process.execPath, backupArgs, { stdio: "inherit" });
  if ((b.status ?? 1) !== 0) {
    falhar("backup prévio falhou — restore ABORTADO, banco intacto");
  }
  ok("backup prévio concluído (se o restore falhar, restaure este dump)");
} else {
  aviso("backup prévio pulado (--local) — sem rollback point");
}

// 5) executa tudo em um único d1 execute (o D1 rollbacka sozinho se falhar)
mkdirSync(DIR_BACKUPS, { recursive: true });
const restaurador = path.join(DIR_BACKUPS, `.restaurar-${ambiente}-${Date.now()}.sql`);
writeFileSync(restaurador, montado.sql);
const exec = wrangler(["d1", "execute", cfg.db, remoto, "--env", cfg.env,
  "--file", restaurador, "-y"]);
if (exec.status !== 0) {
  console.error(exec.stdout);
  console.error(exec.stderr);
  console.error("  ✖ restore FALHOU — o D1 rollbacka para o último estado bom (arquivo mantido p/ diagnóstico).");
  console.error(`     Diagnóstico: ${path.relative(RAIZ, restaurador)}`);
  console.error(`     Rollback point: node scripts/db-restore.mjs ${ambiente} --arquivo backups/<pre-restore>.sql${local ? " --local" : ""}`);
  process.exit(1);
}
ok("schema apagado e dump importado");

// 6) verificação
console.log("▸ Verificação");
const depois = await inventario();

const faltando = [...tabelasEsperadas].filter((t) => !ehInterna(t) && !depois.tabelas.includes(t)).sort();
const sobrando = depois.tabelas.filter((t) => !ehInterna(t) && !tabelasEsperadas.has(t)).sort();
const divergentes = [];
for (const t of [...tabelasEsperadas].sort()) {
  if (ehInterna(t) || !depois.contagens.has(t)) continue;
  const esperado = linhasEsperadas.get(t) ?? 0;
  const real = depois.contagens.get(t);
  if (esperado !== real) divergentes.push({ t, esperado, real });
}

const integridade = wrangler(["d1", "execute", cfg.db, remoto, "--env", cfg.env,
  "--command", "PRAGMA integrity_check", "--json", "-y"]);
let integridadeOk = false;
try {
  const r = resultados(integridade);
  integridadeOk = integridade.status === 0 && String(r[0]?.integrity_check ?? r[0]?.["integrity_check()"] ?? "").toLowerCase() === "ok";
} catch { /* fica false */ }
// O D1 devolve SQLITE_AUTH para integrity_check — a prova de integridade vira
// a comparação de tabelas/linhas contra o dump (acima).
const integridadeBloqueada = `${integridade.stdout}${integridade.stderr}`.includes("SQLITE_AUTH");

let falhas = 0;
if (faltando.length) { falhas++; console.error(`  ✖ tabelas do dump ausentes no banco: ${faltando.join(", ")}`); }
if (sobrando.length) { falhas++; console.error(`  ✖ tabelas extras no banco (não vieram do dump): ${sobrando.join(", ")}`); }
if (divergentes.length) {
  falhas++;
  for (const { t, esperado, real } of divergentes) console.error(`  ✖ ${t}: esperado ${esperado} linha(s) do dump, banco tem ${real}`);
}
if (!integridadeOk && !integridadeBloqueada) { falhas++; console.error("  ✖ PRAGMA integrity_check não retornou ok"); }
if (!integridadeOk && integridadeBloqueada) aviso("integrity_check negado por este D1 (SQLITE_AUTH) — integridade atestada pela comparação de tabelas/linhas contra o dump");

if (falhas === 0) {
  ok(`tabelas (${depois.tabelas.length}) e linhas por tabela conferem com o dump${integridadeOk ? " + integrity_check ok" : ""}`);
  rmSync(restaurador, { force: true }); // script temporário limpo só no sucesso
} else {
  console.error(`  ✖ verificação FALHOU com ${falhas} problema(s) — NÃO considere este restore concluído`);
  process.exit(1);
}

// 7) próximo passo
const migsNoBanco = linhasEsperadas.get("d1_migrations") ?? 0;
console.log(`\n✔ Restore de ${ambiente} concluído e verificado (${migsNoBanco} migration(s) registradas no dump).`);
console.log(`  Próximo passo: ${cfg.migrar}  — aplica migrations pendentes sobre o banco restaurado (deve ser no-op se o dump era atual).`);
