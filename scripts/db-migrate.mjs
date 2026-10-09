#!/usr/bin/env node
/**
 * Migration de PRODUÇÃO com backup OBRIGATÓRIO prévio (pendência #09).
 *
 * Uso:  node scripts/db-migrate.mjs production   (é o que `npm run db:migrate` roda)
 *
 * Ordem:
 *   1. scripts/db-backup.mjs production  → se falhar, a migration NÃO roda;
 *   2. wrangler d1 migrations apply limas-saas-db --remote --env production;
 *   3. se a migration falhar, imprime o caminho de rollback (RUNBOOK-BACKUP-D1.md).
 *
 * Não existe flag para pular o backup: é obrigatório por decisão desta
 * pendência. Se o backup falhar, o certo é corrigir o backup — nunca
 * migrar sem ponto de restauração.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(RAIZ, "node_modules", "wrangler", "bin", "wrangler.js");

const backup = spawnSync(
  process.execPath,
  [path.join(RAIZ, "scripts", "db-backup.mjs"), "production", "--rotulo", "pre-migrate"],
  { stdio: "inherit" },
);
if ((backup.status ?? 1) !== 0) {
  console.error("\n✖ BACKUP DE PRODUÇÃO FALHOU — migration ABORTADA (banco intacto).");
  console.error("  Corrija o backup (ver RUNBOOK-BACKUP-D1.md §Backup) e rode `npm run db:migrate` de novo.");
  console.error("  Nunca rode migration de produção sem backup.");
  process.exit(1);
}

console.log("\n▸ Backup OK — aplicando migrations em produção…");
const migra = spawnSync(
  process.execPath,
  [WRANGLER, "d1", "migrations", "apply", "limas-saas-db", "--remote", "--env", "production"],
  { stdio: "inherit" },
);
const status = migra.status ?? 1;
if (status !== 0) {
  console.error("\n✖ MIGRATION DE PRODUÇÃO FALHOU.");
  console.error("  1. Não tente rodar de novo às cegas — leia o erro primeiro.");
  console.error("  2. Se o schema ficou incompleto, corrija com uma migration NOVA (forward-fix).");
  console.error("  3. Só em perda/corrupção de dados: restaure o backup recém-feito (backups/prod-*-pre-migrate.sql)");
  console.error("     seguindo RUNBOOK-BACKUP-D1.md §Restore de produção.");
  process.exit(status);
}
console.log("\n✔ Migrations de produção aplicadas. Backup prévio disponível em backups/ (prod-*-pre-migrate.sql).");
