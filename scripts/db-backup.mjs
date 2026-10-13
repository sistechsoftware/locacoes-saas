#!/usr/bin/env node
/**
 * Backup do D1 (pendência #09) — exporta o banco, confere a integridade do
 * dump, assina com SHA-256, envia para o bucket R2 de backups (retenção
 * mínima de 30 dias), BAIXA o objeto de volta do R2 remoto para confirmar que
 * ele existe e bate byte a byte, e só então poda os backups locais fora da
 * janela de retenção.
 *
 * Etapas (o workflow e o manifesto refletem esta ordem):
 *   1. export do D1   2. validação do dump   3. assinatura SHA-256
 *   4. upload p/ R2   5. verificação remota  6. sucesso ou falha (exit != 0)
 *
 * ATENÇÃO: o upload usa `r2 object put --remote` de propósito. Sem a flag o
 * wrangler grava no R2 SIMULADO local (.wrangler/state/v3/r2), o comando sai
 * com 0 e o backup nunca sai da máquina — é exatamente o que acontecia até a
 * auditoria de 2026-10-12 (bucket remoto com 0 objetos).
 *
 * Uso:
 *   node scripts/db-backup.mjs production                       # exporta + R2
 *   node scripts/db-backup.mjs staging
 *   node scripts/db-backup.mjs production --rotulo pre-migrate  # rótulo no nome
 *   node scripts/db-backup.mjs production --manter-dias 45      # retenção local
 *   node scripts/db-backup.mjs staging --sem-r2                 # só local
 *   node scripts/db-backup.mjs staging --local                  # D1 local (teste)
 *
 * Também roda automaticamente antes de `npm run db:migrate` (backup
 * OBRIGATÓRIO: se o backup falhar, a migration de produção NÃO executa —
 * não existe flag para pular).
 *
 * Saída:  backups/<prefixo>-<AAAA-MM-DD-HHMMSS>[-<rotulo>].sql (+ .sha256)
 * R2:     s3://<BUCKET>/d1/<mesmo arquivo>   (BUCKET: env BACKUP_R2_BUCKET
 *         ou "limas-saas-backups" — bucket criado automaticamente se faltar)
 * Log:    backups/manifesto.log (uma linha por backup, para auditoria)
 *
 * Env de teste (nunca usar contra produção):
 *   WRANGLER_BIN      binário simulado do wrangler (tests/db-backup.test.ts)
 *   BACKUP_DIR        pasta de destino dos dumps (padrão: <raiz>/backups)
 *   BACKUP_TENTATIVAS tentativas por etapa transitória (padrão 3)
 *   BACKUP_ESPERA_MS  espera entre tentativas em ms (padrão 5000)
 *
 * Sai com código 0 só se export + conferência + upload + VERIFICAÇÃO
 * remota terminarem com sucesso — assim o agendador diário falha alto quando
 * o backup falha, e nunca reporta sucesso sem um objeto recuperável no R2.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// WRANGLER_BIN / BACKUP_DIR são só para teste: permitem rodar o script contra
// um wrangler simulado e uma pasta isolada, sem tocar em `backups/` reais.
const WRANGLER = process.env.WRANGLER_BIN || path.join(RAIZ, "node_modules", "wrangler", "bin", "wrangler.js");
const DIR_BACKUPS = process.env.BACKUP_DIR ? path.resolve(process.env.BACKUP_DIR) : path.join(RAIZ, "backups");
const BUCKET = process.env.BACKUP_R2_BUCKET || "limas-saas-backups";

function numEnv(nome, padrao) {
  const v = Number(process.env[nome]);
  return Number.isFinite(v) && v >= 0 ? v : padrao;
}

/** Tentativas por etapa transitória (export, upload, verificação). */
const TENTATIVAS = Math.max(1, Math.trunc(numEnv("BACKUP_TENTATIVAS", 3)));
/** Espera entre tentativas, em ms (0 nos testes). */
const ESPERA_MS = Math.trunc(numEnv("BACKUP_ESPERA_MS", 5000));

/** Ambientes suportados: nome do banco, flag --env do wrangler e prefixo do arquivo. */
const AMBIENTES = {
  production: { db: "limas-saas-db", env: "production", prefixo: "prod" },
  staging: { db: "limas-saas-staging-db", env: "staging", prefixo: "staging" },
};

const ok = (m) => console.log(`  ✔ ${m}`);
const falhar = (m) => {
  console.error(`  ✖ ${m}`);
  process.exit(1);
};

/* ------------------------------- args ---------------------------------- */

const args = process.argv.slice(2).filter((a) => a !== "--");
const ajuda = args.includes("--ajuda") || args.includes("--help");
const semR2 = args.includes("--sem-r2");
const local = args.includes("--local");

function valorDe(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

if (ajuda) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0] + "*/");
  process.exit(0);
}

const ambiente = args.find((a) => !a.startsWith("--") && a !== valorDe("--rotulo") && a !== valorDe("--manter-dias"));
const rotulo = valorDe("--rotulo");
const manterDias = Number(valorDe("--manter-dias") ?? 30);

if (!ambiente || !AMBIENTES[ambiente]) {
  console.error("Uso: node scripts/db-backup.mjs <production|staging> [--sem-r2] [--local] [--rotulo x] [--manter-dias N]");
  process.exit(2);
}
if (!Number.isInteger(manterDias) || manterDias < 1) falhar("--manter-dias precisa ser um número inteiro >= 1");
if (manterDias < 30) console.warn("  ⚠ --manter-dias < 30 viola a retenção mínima de 30 dias da pendência #09");

// Preflight: sem credencial o wrangler aborta no primeiro comando. Falhar aqui
// diz exatamente O QUE falta (no Actions o erro saía no meio do export).
if (!local && !process.env.CLOUDFLARE_API_TOKEN) {
  falhar(
    "CLOUDFLARE_API_TOKEN ausente — export e upload remotos exigem credencial do Cloudflare " +
      "(GitHub → Settings → Secrets and variables → Actions; ver RUNBOOK-BACKUP-D1.md §3.2). " +
      "Nenhum backup foi gerado.",
  );
}
if (!local && !process.env.CLOUDFLARE_ACCOUNT_ID) {
  console.warn("  ⚠ CLOUDFLARE_ACCOUNT_ID ausente — o wrangler só segue sozinho se o token tiver conta única");
}

const cfg = AMBIENTES[ambiente];
const remoto = local ? "--local" : "--remote";

/** Roda o wrangler do projeto (node_modules) e devolve {status, stdout, stderr}. */
function wrangler(cmdArgs) {
  const r = spawnSync(process.execPath, [WRANGLER, ...cmdArgs], { encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Espera síncrona (o script é todo bloqueante); BACKUP_ESPERA_MS=0 nos testes. */
function dormir(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Repete `fn` até {ok:true} ou esgotar TENTATIVAS. `fn` devolve {ok, motivo, ...}.
 * Só uma falha PERMANENTE desce para `falhar()` — transitória (rede, API 5xx)
 * ganha nova chance, sempre sobre o mesmo arquivo/chave (sem duplicar nada).
 */
function comTentativas(rotulo, fn) {
  let ultimo;
  for (let t = 1; t <= TENTATIVAS; t++) {
    ultimo = fn();
    if (ultimo.ok) {
      if (t > 1) ok(`${rotulo}: recuperou na tentativa ${t}/${TENTATIVAS}`);
      return ultimo;
    }
    console.error(`  ⚠ ${rotulo}: tentativa ${t}/${TENTATIVAS} falhou — ${ultimo.motivo}`);
    if (t < TENTATIVAS) dormir(ESPERA_MS);
  }
  return ultimo;
}

/* ------------------------------ timestamp -------------------------------- */

const agora = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const carimbo = `${agora.getFullYear()}-${p2(agora.getMonth() + 1)}-${p2(agora.getDate())}-${p2(agora.getHours())}${p2(agora.getMinutes())}${p2(agora.getSeconds())}`;
const nomeArquivo = `${cfg.prefixo}-${carimbo}${rotulo ? `-${rotulo}` : ""}.sql`;
mkdirSync(DIR_BACKUPS, { recursive: true });
const caminho = path.join(DIR_BACKUPS, nomeArquivo);

// Concorrência: duas execuções no mesmo segundo gerariam o MESMO nome e uma
// sobrescreveria a outra (arquivo e chave do R2). Nada é sobrescrito — o run
// falha alto e a segunda execução pode ser refeita um segundo depois.
for (const jaExistente of [caminho, `${caminho}.sha256`]) {
  if (existsSync(jaExistente)) {
    falhar(
      `${path.relative(RAIZ, jaExistente)} já existe (execução concorrente no mesmo segundo?) — ` +
        "nada foi sobrescrito; repita o comando em instantes",
    );
  }
}

/* ------------------------------- export --------------------------------- */

console.log(`▸ Backup ${ambiente} → ${path.relative(RAIZ, caminho)}`);
console.log("▸ Etapa 1/5 — export do D1");
// --env sempre (mesmo --local): sem ele o wrangler não acha o binding do staging
const exportArgs = ["d1", "export", cfg.db, remoto, "--env", cfg.env, "--output", caminho, "-y"];
const exp = comTentativas("export do D1", () => {
  const r = wrangler(exportArgs);
  return { ok: r.status === 0, motivo: `wrangler saiu com ${r.status}`, r };
});
if (!exp.ok) {
  console.error(exp.r.stdout);
  console.error(exp.r.stderr);
  // um arquivo pela metade não pode ficar em backups/ parecendo backup
  if (existsSync(caminho) && statSync(caminho).mtimeMs >= Date.now() - 60_000) unlinkSync(caminho);
  falhar(`falha no export do D1 após ${TENTATIVAS} tentativa(s) — nenhum dump gerado`);
}

console.log("▸ Etapa 2/5 — validação do dump");
if (!existsSync(caminho)) falhar("o wrangler não gerou o arquivo de backup");
const tamanho = statSync(caminho).size;
if (tamanho < 100) falhar(`backup suspeito: apenas ${tamanho} bytes — arquivo descartado como backup`);

const bytes = readFileSync(caminho);
const conteudo = bytes.toString("utf8");
if (!/CREATE TABLE/i.test(conteudo)) falhar("dump não contém CREATE TABLE — export incompleto");
if (!/INSERT INTO "d1_migrations"/i.test(conteudo)) {
  falhar("dump sem a tabela d1_migrations — export incompleto (migrations não exportadas)");
}
ok(`export OK — ${(tamanho / 1024).toFixed(0)} KB, ${conteudo.match(/INSERT INTO/g)?.length ?? 0} linhas de dados`);

/* ------------------------------- sha256 --------------------------------- */

console.log("▸ Etapa 3/5 — assinatura SHA-256");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const sidecar = `${caminho}.sha256`;
writeFileSync(sidecar, `${sha256}  ${nomeArquivo}\n`);
ok(`SHA-256 ${sha256}`);

/* --------------------------------- R2 ----------------------------------- */

let destinoR2 = "(não enviado: --sem-r2 ou D1 local)";
if (!semR2 && !local) {
  console.log("▸ Etapa 4/5 — upload para o R2 remoto");
  // `r2 bucket *` são comandos de conta (sempre remotos) — não aceitam flag.
  const info = wrangler(["r2", "bucket", "info", BUCKET]);
  if (info.status !== 0) {
    console.log(`  … bucket "${BUCKET}" não encontrado — criando`);
    const criado = wrangler(["r2", "bucket", "create", BUCKET]);
    if (criado.status !== 0 && wrangler(["r2", "bucket", "info", BUCKET]).status !== 0) {
      console.error(criado.stdout);
      console.error(criado.stderr);
      falhar("falha ao criar o bucket de backups");
    }
  }
  const chave = `d1/${nomeArquivo}`;
  // --remote OBRIGATÓRIO: sem ele o wrangler grava no R2 simulado local
  // (.wrangler/state/v3/r2), sai com 0 e o objeto nunca chega ao bucket real.
  const envio = comTentativas("upload para o R2", () => {
    const p1 = wrangler(["r2", "object", "put", `${BUCKET}/${chave}`, "--file", caminho, "--remote", "-y"]);
    if (p1.status !== 0) return { ok: false, motivo: `put do .sql saiu com ${p1.status}`, r: p1 };
    const p2 = wrangler(["r2", "object", "put", `${BUCKET}/${chave}.sha256`, "--file", sidecar, "--remote", "-y"]);
    if (p2.status !== 0) return { ok: false, motivo: `put do .sha256 saiu com ${p2.status}`, r: p2 };
    return { ok: true };
  });
  if (!envio.ok) {
    console.error(envio.r.stdout);
    console.error(envio.r.stderr);
    falhar(
      `falha no upload para o R2 após ${TENTATIVAS} tentativa(s) — cópia local íntegra em ` +
        `${path.relative(RAIZ, caminho)} (sem armazenamento independente)`,
    );
  }
  destinoR2 = `r2://${BUCKET}/${chave}`;
  ok(`upload concluído → ${destinoR2}`);

  console.log("▸ Etapa 5/5 — verificação do objeto no R2 remoto");
  const verif = comTentativas("verificação remota", () => verificarNoR2(BUCKET, chave, caminho, sidecar));
  if (!verif.ok) falhar(`${verif.motivo} — NÃO considere este backup armazenado`);
}

/**
 * Baixa o objeto de volta do R2 REMOTO e confere (prova de recuperação):
 *   1. o .sql remoto existe e tem o mesmo SHA-256 do local;
 *   2. o .sha256 remoto é byte a byte igual ao local.
 * É a etapa que separa "comando terminou" de "existe cópia recuperável".
 */
function verificarNoR2(bucket, chave, arquivoLocal, sidecarLocal) {
  const tmp = mkdtempSync(path.join(tmpdir(), "backup-r2-check-"));
  try {
    const baixado = path.join(tmp, "objeto.sql");
    const g1 = wrangler(["r2", "object", "get", `${bucket}/${chave}`, "--file", baixado, "--remote"]);
    if (g1.status !== 0) {
      return { ok: false, motivo: `objeto não encontrado no R2 remoto (get saiu com ${g1.status})` };
    }
    const recebido = readFileSync(baixado);
    const esperado = readFileSync(arquivoLocal);
    if (recebido.length !== esperado.length) {
      return { ok: false, motivo: `tamanho remoto ${recebido.length} B ≠ local ${esperado.length} B` };
    }
    const shaRecebido = createHash("sha256").update(recebido).digest("hex");
    const shaEsperado = createHash("sha256").update(esperado).digest("hex");
    if (shaRecebido !== shaEsperado) {
      return { ok: false, motivo: `SHA-256 remoto ${shaRecebido} ≠ local ${shaEsperado}` };
    }
    const baixadoSide = path.join(tmp, "objeto.sql.sha256");
    const g2 = wrangler(["r2", "object", "get", `${bucket}/${chave}.sha256`, "--file", baixadoSide, "--remote"]);
    if (g2.status !== 0) return { ok: false, motivo: "o .sha256 não está no R2 remoto" };
    if (readFileSync(baixadoSide, "utf8") !== readFileSync(sidecarLocal, "utf8")) {
      return { ok: false, motivo: "o .sha256 remoto difere do local" };
    }
    ok(`verificado no R2 remoto — SHA-256 ${shaRecebido}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, motivo: `erro ao conferir o objeto no R2: ${e.message}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* --------------------------- retenção local ------------------------------ */

const corte = Date.now() - manterDias * 86_400_000;
let podados = 0;
for (const arquivo of readdirSync(DIR_BACKUPS)) {
  const caminhoArquivo = path.join(DIR_BACKUPS, arquivo);
  if (caminhoArquivo === caminho || caminhoArquivo === sidecar) continue;
  if (!arquivo.startsWith(`${cfg.prefixo}-`)) continue;
  if (!arquivo.endsWith(".sql") && !arquivo.endsWith(".sql.sha256")) continue;
  if (statSync(caminhoArquivo).mtimeMs < corte) {
    unlinkSync(caminhoArquivo);
    podados++;
  }
}
ok(`retenção local: ${manterDias} dias (removidos ${podados} arquivo(s) antigos)`);

/* ------------------------------- manifesto -------------------------------- */

const linha = [
  agora.toISOString(),
  ambiente,
  "ok",
  tamanho,
  sha256,
  nomeArquivo,
  destinoR2,
].join(",");
appendFileSync(path.join(DIR_BACKUPS, "manifesto.log"), `${linha}\n`);

console.log(
  `✔ Backup de ${ambiente} concluído e disponível para recuperação: ${path.relative(RAIZ, caminho)} ` +
    `(retenção local ${manterDias} dias; R2: ${destinoR2})`,
);
