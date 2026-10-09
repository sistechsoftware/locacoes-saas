#!/usr/bin/env node
/**
 * Backup do D1 (pendência #09) — exporta o banco, confere a integridade do
 * dump, assina com SHA-256, envia para o bucket R2 de backups (retenção
 * mínima de 30 dias) e poda os backups locais fora da janela de retenção.
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
 * Sai com código 0 só se export + conferência (+ upload, se aplicável)
 * terminarem com sucesso — assim o agendador diário falha alto quando o
 * backup falha.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(RAIZ, "node_modules", "wrangler", "bin", "wrangler.js");
const DIR_BACKUPS = path.join(RAIZ, "backups");
const BUCKET = process.env.BACKUP_R2_BUCKET || "limas-saas-backups";

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

const cfg = AMBIENTES[ambiente];
const remoto = local ? "--local" : "--remote";

/** Roda o wrangler do projeto (node_modules) e devolve {status, stdout, stderr}. */
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

/* ------------------------------ timestamp -------------------------------- */

const agora = new Date();
const p2 = (n) => String(n).padStart(2, "0");
const carimbo = `${agora.getFullYear()}-${p2(agora.getMonth() + 1)}-${p2(agora.getDate())}-${p2(agora.getHours())}${p2(agora.getMinutes())}${p2(agora.getSeconds())}`;
const nomeArquivo = `${cfg.prefixo}-${carimbo}${rotulo ? `-${rotulo}` : ""}.sql`;
mkdirSync(DIR_BACKUPS, { recursive: true });
const caminho = path.join(DIR_BACKUPS, nomeArquivo);

/* ------------------------------- export --------------------------------- */

console.log(`▸ Backup ${ambiente} → ${path.relative(RAIZ, caminho)}`);
// --env sempre (mesmo --local): sem ele o wrangler não acha o binding do staging
const exportArgs = ["d1", "export", cfg.db, remoto, "--env", cfg.env, "--output", caminho, "-y"];
wranglerOuFalha(exportArgs, "falha no export do D1");

if (!existsSync(caminho)) falhar("o wrangler não gerou o arquivo de backup");
const tamanho = statSync(caminho).size;
if (tamanho < 100) falhar(`backup suspeito: apenas ${tamanho} bytes`);

const conteudo = readFileSync(caminho, "utf8");
if (!/CREATE TABLE/i.test(conteudo)) falhar("dump não contém CREATE TABLE — export incompleto");
if (!/INSERT INTO "d1_migrations"/i.test(conteudo)) {
  falhar("dump sem a tabela d1_migrations — export incompleto (migrations não exportadas)");
}
ok(`export OK — ${(tamanho / 1024).toFixed(0)} KB, ${conteudo.match(/INSERT INTO/g)?.length ?? 0} linhas de dados`);

/* ------------------------------- sha256 --------------------------------- */

const sha256 = createHash("sha256").update(conteudo).digest("hex");
const sidecar = `${caminho}.sha256`;
writeFileSync(sidecar, `${sha256}  ${nomeArquivo}\n`);
ok(`SHA-256 ${sha256}`);

/* --------------------------------- R2 ----------------------------------- */

let destinoR2 = "(não enviado: --sem-r2 ou D1 local)";
if (!semR2 && !local) {
  const info = wrangler(["r2", "bucket", "info", BUCKET]);
  if (info.status !== 0) {
    console.log(`  … bucket "${BUCKET}" não encontrado — criando`);
    wranglerOuFalha(["r2", "bucket", "create", BUCKET], "falha ao criar o bucket de backups");
  }
  const chave = `d1/${nomeArquivo}`;
  wranglerOuFalha(
    ["r2", "object", "put", `${BUCKET}/${chave}`, "--file", caminho, "-y"],
    "falha no upload para o R2",
  );
  wranglerOuFalha(
    ["r2", "object", "put", `${BUCKET}/${chave}.sha256`, "--file", sidecar, "-y"],
    "falha no upload do checksum para o R2",
  );
  destinoR2 = `r2://${BUCKET}/${chave}`;
  ok(`upload OK → ${destinoR2}`);
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

console.log(`✔ Backup de ${ambiente} concluído: ${path.relative(RAIZ, caminho)} (retenção local ${manterDias} dias; R2: ${destinoR2})`);
