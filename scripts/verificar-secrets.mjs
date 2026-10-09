#!/usr/bin/env node
/**
 * Pré-deploy: confere se TODOS os secrets declarados em wrangler.jsonc
 * ("secrets.required") existem no ambiente alvo e se os valores locais têm
 * formato válido. Pendência #08 — antes, o deploy passava mesmo sem os
 * secrets do Asaas/Resend e o sistema operava sem cobrança e sem e-mail.
 *
 * Uso:
 *   node scripts/verificar-secrets.mjs staging            # remoto + local
 *   node scripts/verificar-secrets.mjs production
 *   node scripts/verificar-secrets.mjs dev                # só .dev.vars.saas
 *   node scripts/verificar-secrets.mjs production --sem-remoto   # sem wrangler
 *
 * Também roda automaticamente antes de `npm run deploy:staging|production`.
 *
 * O que ele NÃO consegue fazer: `wrangler secret list` devolve só NOMES.
 * Valores (ex.: ASAAS_ENVIRONMENT=production, RESEND_FROM sem resend.dev)
 * só podem ser conferidos em .dev.vars.saas (local) ou manualmente no
 * dashboard — por isso o script insere um lembrete explícito na saída.
 *
 * NUNCA imprime valores, só nomes e regras violadas.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(RAIZ, "wrangler.jsonc");
const DEV_VARS = path.join(RAIZ, ".dev.vars.saas");

const AMBIENTES = new Set(["staging", "production", "dev"]);
const problemas = [];
const avisos = [];
const ok = (msg) => console.log(`  ✔ ${msg}`);
const falha = (msg) => problemas.push(msg);
const aviso = (msg) => avisos.push(msg);

/* ------------------------------- args ---------------------------------- */

const args = process.argv.slice(2).filter((a) => a !== "--");
const semRemoto = args.includes("--sem-remoto");
const ajuda = args.includes("--ajuda") || args.includes("--help");
const ambiente = args.find((a) => !a.startsWith("--"));

if (ajuda) {
  console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("*/")[0] + "*/");
  process.exit(0);
}
if (!ambiente || !AMBIENTES.has(ambiente)) {
  console.error("Uso: node scripts/verificar-secrets.mjs <staging|production|dev> [--sem-remoto]");
  process.exit(2);
}

/* --------------------------- wrangler.jsonc ----------------------------- */

/** Remove comentários de JSONC sem tocar em `//` dentro de strings (URLs). */
function semComentarios(texto) {
  let fora = true;
  let out = "";
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (fora && c === '"') {
      fora = false;
      out += c;
      continue;
    }
    if (!fora) {
      out += c;
      if (c === "\\") {
        out += texto[i + 1] ?? "";
        i++;
      } else if (c === '"') fora = true;
      continue;
    }
    if (c === "/" && texto[i + 1] === "/") {
      while (i < texto.length && texto[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && texto[i + 1] === "*") {
      i += 2;
      while (i < texto.length && !(texto[i] === "*" && texto[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

const cfg = JSON.parse(semComentarios(readFileSync(WRANGLER, "utf8")));
const cfgEnv = cfg.env?.[ambiente] ?? cfg;
const obrigatorios = cfgEnv.secrets?.required ?? [];
const vars = cfgEnv.vars ?? {};

if (obrigatorios.length === 0) {
  falha(`wrangler.jsonc: env "${ambiente}" sem secrets.required — declare os secrets primeiro`);
}

/* ------------------------- validação de formato ------------------------- */

/**
 * Regra por nome. Devolve string com o problema, ou null.
 * O valor NUNCA aparece na mensagem.
 */
function problemaDeFormato(nome, valor) {
  const v = (valor ?? "").trim();
  if (!v) return "vazio";
  if (/\s{2,}/.test(v) || v !== (valor ?? "").trim()) return "espaços em branco nas pontas/duplos";
  switch (nome) {
    case "RESEND_API_KEY":
      if (v.length < 8) return "curto demais para ser uma chave Resend";
      return null;
    case "RESEND_FROM":
      if (/@resend\.dev(\b|>)/i.test(v)) return "usa o domínio de teste resend.dev — usar domínio próprio verificado";
      if (!/.+@.+\..+/.test(v)) return "não parece um remetente e-mail válido";
      return null;
    case "ASAAS_ENVIRONMENT":
      if (v !== "production" && v !== "sandbox") return 'só pode ser "production" ou "sandbox"';
      return null;
    case "VAPID_PUBLIC_KEY":
    case "VAPID_PRIVATE_KEY":
      if (v.length < 20) return "curto demais para uma chave VAPID";
      return null;
    case "PUBLIC_URL":
      if (!/^https:\/\//.test(v)) return "precisa começar com https://";
      return null;
    default:
      return null;
  }
}

/** Lê .dev.vars.saas (KEY=VALUE, comentários com #) sem expor valores. */
function lerDevVars() {
  if (!existsSync(DEV_VARS)) return null;
  const mapa = {};
  for (const linha of readFileSync(DEV_VARS, "utf8").split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m && !linha.trim().startsWith("#")) mapa[m[1]] = m[2];
  }
  return mapa;
}

/* ------------------------------ execução -------------------------------- */

console.log(`\nPré-deploy de secrets — ambiente: ${ambiente}\n`);

if (ambiente === "dev") {
  const locais = lerDevVars();
  if (!locais) {
    falha(".dev.vars.saas não encontrado (copie .env.example e preencha; o arquivo é gitignored)");
  } else {
    for (const nome of obrigatorios) {
      const problema = problemaDeFormato(nome, locais[nome]);
      if (problema) falha(`${nome}: ${problema}`);
      else ok(`${nome} presente e com formato válido (valor não exibido)`);
    }
  }
} else {
  // 1) presença remota
  if (semRemoto) {
    aviso("--sem-remoto: presença no Worker NÃO foi conferida");
  } else {
    const flags = ["wrangler", "secret", "list", "--env", ambiente];
    const base = { cwd: RAIZ, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 };
    const r =
      process.platform === "win32"
        ? spawnSync(`npx ${flags.join(" ")}`, { ...base, shell: true })
        : spawnSync("npx", flags, base);
    if (r.status !== 0) {
      falha(`wrangler secret list --env ${ambiente} falhou: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
    } else {
      const inicio = r.stdout.indexOf("[");
      const fim = r.stdout.lastIndexOf("]");
      let remotos = [];
      try {
        remotos = JSON.parse(r.stdout.slice(inicio, fim + 1)).map((s) => s.name);
      } catch {
        falha("saída do wrangler secret list ilegível — conferir manualmente");
      }
      if (remotos.length) {
        const faltando = obrigatorios.filter((n) => !remotos.includes(n));
        if (faltando.length) falha(`ausentes no Worker (${ambiente}): ${faltando.join(", ")}`);
        else ok(`todos os ${obrigatorios.length} secrets declarados existem no Worker (${ambiente})`);
        const extras = remotos.filter((n) => !obrigatorios.includes(n));
        if (extras.length) aviso(`no Worker mas fora de secrets.required: ${extras.join(", ")}`);
      }
    }
  }

  // 2) formato dos valores locais (o único lugar onde dá para ver valor).
  //    Não governa o Worker remoto, então aqui é AVISO — o bloqueio é a
  //    presença remota. Em `dev` (abaixo) o mesmo problema é falha.
  const locais = lerDevVars();
  if (locais) {
    for (const nome of obrigatorios) {
      if (locais[nome] === undefined) {
        aviso(`${nome}: ausente no .dev.vars.saas local`);
        continue;
      }
      const problema = problemaDeFormato(nome, locais[nome]);
      if (problema) aviso(`${nome} (.dev.vars.saas): ${problema} — se o secret remoto for igual, o ambiente "${ambiente}" não funcionará`);
      else ok(`${nome} local com formato válido (valor não exibido)`);
    }
  } else {
    aviso(".dev.vars.saas ausente — não dá para conferir valores localmente");
  }

  // 3) valores que o `secret list` não devolve — conferência manual
  if (ambiente === "production") {
    aviso('confirme manualmente os VALORES dos secrets de produção: ASAAS_ENVIRONMENT deve ser "production" e RESEND_FROM deve ter domínio próprio verificado (wrangler secret list mostra só nomes; dashboard Cloudflare → Workers → limas-saas → Settings → Variables)');
  }
  if (!vars.PUBLIC_URL) aviso('vars.PUBLIC_URL vazio — links dos e-mails do cron ficam relativos');
}

/* ------------------------------ relatório -------------------------------- */

for (const a of avisos) console.log(`  ⚠ ${a}`);
if (problemas.length) {
  console.log("");
  for (const p of problemas) console.log(`  ✖ ${p}`);
  console.log(`\nPRÉ-DEPLOY REPROVADO: ${problemas.length} problema(s) no ambiente "${ambiente}".`);
  console.log("Deploy bloqueado — sem estes secrets o SaaS roda sem cobrança/e-mail em silêncio.");
  process.exit(1);
}
console.log("\nPré-deploy OK — secrets declarados e presentes.\n");
