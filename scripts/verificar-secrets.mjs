#!/usr/bin/env node
/**
 * Pré-deploy: garante que o sistema publicado NUNCA opere sem cobrança e sem
 * e-mail em silêncio (pendência #08). Por ambiente:
 *
 *   1. Secrets do Worker: TODOS os nomes de "secrets.required" (wrangler.jsonc)
 *      precisam existir — exceto o trio Asaas, que também pode vir do painel
 *      (item 2). VAPID e RESEND são obrigatórios SEMPRE no Worker.
 *   2. Credenciais Asaas (ASAAS_API_KEY / ASAAS_ENVIRONMENT /
 *      ASAAS_WEBHOOK_TOKEN) em ALGUM dos dois caminhos aceitos:
 *        a) secret do Worker; ou
 *        b) cadastro no painel /saas — tabela platform_settings no D1 do
 *           ambiente. Exige o secret PAINEL_CHAVE no Worker (é a chave de
 *           cifra dos segredos do painel) e o prefixo enc:v1: nos valores.
 *      Mesmo campo nos dois caminhos: o secret VENCE e o pré-deploy avisa,
 *      porque a edição no painel passaria a ser ignorada.
 *   3. Valores que o `secret list` não devolve:
 *        - formato do .dev.vars.saas (local);
 *        - asaas_environment quando vem do painel (em claro por design):
 *          em produção SÓ vale "production" — sandbox em produção é BLOQUEIO
 *          (a cobrança real nunca aconteceria); em staging, "production" é
 *          aviso (API real a partir de ambiente de teste).
 *
 * Uso:
 *   node scripts/verificar-secrets.mjs staging            # remoto + local
 *   node scripts/verificar-secrets.mjs production
 *   node scripts/verificar-secrets.mjs dev                # só .dev.vars.saas
 *   node scripts/verificar-secrets.mjs production --sem-remoto   # sem wrangler
 *
 * Também roda automaticamente antes de `npm run deploy:staging|production`.
 *
 * O que ele NÃO consegue fazer: `wrangler secret list` devolve só NOMES e
 * segredos do painel não são decifráveis aqui — se ASAAS_ENVIRONMENT vier do
 * secret do Worker, o VALOR só pode ser conferido em .dev.vars.saas (local) ou
 * manualmente no dashboard — por isso o script insere um lembrete explícito.
 *
 * NUNCA imprime valores de segredo, só nomes, regras violadas e (apenas para
 * asaas_environment, texto público do painel) o valor ilegível.
 */
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = path.join(RAIZ, "wrangler.jsonc");
const DEV_VARS = path.join(RAIZ, ".dev.vars.saas");

const AMBIENTES = new Set(["staging", "production", "dev"]);

/** Trio Asaas: exigido em ALGUM lugar — secret do Worker ou painel (D1). */
export const TRIO_ASAAS = ["ASAAS_API_KEY", "ASAAS_ENVIRONMENT", "ASAAS_WEBHOOK_TOKEN"];
/** Nome de cada secret do trio na tabela platform_settings (migration 0038). */
const NO_PAINEL = {
  ASAAS_API_KEY: "asaas_api_key",
  ASAAS_ENVIRONMENT: "asaas_environment",
  ASAAS_WEBHOOK_TOKEN: "asaas_webhook_token",
};
/** Segredos do painel só valem cifrados (ver src/lib/platform-settings.ts). */
const PREFIXO_CIFRA = "enc:v1:";
const SEGREDOS_DO_PAINEL = new Set(["asaas_api_key", "asaas_webhook_token"]);

/**
 * Resolve o trio Asaas campo a campo: secret do Worker > painel > ausente.
 * A resolução é por campo porque é exatamente o que o Worker faz em runtime
 * (credenciaisAsaas em src/lib/platform-settings.ts).
 *
 * @param {Set<string>} worker nomes de secrets presentes no Worker
 * @param {Record<string, string>} painel linhas de platform_settings (chave -> valor bruto)
 * @returns {{ campos: Record<string, { origem: "worker" | "painel" | "ausente", valor: string | null }>, faltando: string[], misto: string[] }}
 *   faltando: sem secret E sem painel; misto: presente nos dois (secret vence).
 */
export function resolverTrio(worker, painel) {
  const campos = {};
  const faltando = [];
  const misto = [];
  for (const segredo of TRIO_ASAAS) {
    const nomePainel = NO_PAINEL[segredo];
    const noWorker = worker.has(segredo);
    const noPainel = Object.prototype.hasOwnProperty.call(painel, nomePainel);
    if (noWorker) campos[segredo] = { origem: "worker", valor: null };
    else if (noPainel) campos[segredo] = { origem: "painel", valor: painel[nomePainel] };
    else {
      campos[segredo] = { origem: "ausente", valor: null };
      faltando.push(segredo);
    }
    if (noWorker && noPainel) misto.push(segredo);
  }
  return { campos, faltando, misto };
}

/**
 * Regra de valor para asaas_environment quando é legível (vem do painel).
 * Produção SÓ aceita "production" (sandbox em produção = bloqueio); staging
 * com "production" é aviso. Vindo do secret do Worker o valor não é legível —
 * a conferência manual fica no aviso de produção do rodapé.
 *
 * @param {string} ambiente
 * @param {"worker" | "painel" | "ausente"} origem
 * @param {string | null} valor
 * @returns {{ falha?: string, aviso?: string }}
 */
export function regraAmbiente(ambiente, origem, valor) {
  if (origem !== "painel") return {};
  const limpo = String(valor ?? "").trim();
  if (ambiente === "production" && limpo !== "production") {
    return {
      falha: `asaas_environment="${limpo}" no painel de produção — em produção só vale "production"; com "${limpo}" a cobrança real nunca acontece. Troque no painel /saas antes do deploy.`,
    };
  }
  if (ambiente !== "production" && limpo === "production") {
    return {
      aviso: `asaas_environment="production" no painel de ${ambiente} — aponta para a API real do Asaas a partir de um ambiente de teste`,
    };
  }
  return {};
}

/**
 * Segredo do painel está cifrado (prefixo enc:v1:)? asaas_environment é texto
 * em claro por design (não sensível).
 *
 * @param {string} chave nome em platform_settings
 * @param {string} valor valor bruto gravado
 * @returns {boolean}
 */
export function segredoCifrado(chave, valor) {
  if (!SEGREDOS_DO_PAINEL.has(chave)) return true;
  return typeof valor === "string" && valor.startsWith(PREFIXO_CIFRA);
}

/**
 * Executa wrangler via npx. No Windows o spawn exige shell: true, e o JOIN
 * dos args sem aspas quebra argumentos com espaços/parênteses (o SQL do d1
 * execute) — por isso cada argumento vai entre aspas duplas (o SQL usa só
 * aspas simples, seguras dentro delas).
 */
function execWrangler(args) {
  const base = { cwd: RAIZ, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 };
  if (process.platform === "win32") {
    const comando = ["npx", ...args.map((a) => `"${String(a).replace(/"/g, '\\"')}"`)].join(" ");
    return spawnSync(comando, { ...base, shell: true });
  }
  return spawnSync("npx", args, base);
}

/**
 * Lê as credenciais Asaas do painel no D1 do ambiente. O SQL só seleciona
 * as colunas — nenhum valor de segredo pode aparecer na mensagem de erro.
 * @returns {{ painel?: Record<string, string>, erro?: string }}
 */
function consultarPainel(ambiente, databaseName) {
  const sql =
    "SELECT key, value FROM platform_settings WHERE key IN ('asaas_api_key','asaas_environment','asaas_webhook_token')";
  const r = execWrangler(["wrangler", "d1", "execute", databaseName, "--env", ambiente, "--json", "--command", sql]);
  const bruto = String(r.stdout || "").trim();
  if (r.status !== 0) {
    const detalhe =
      (bruto || String(r.stderr || ""))
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-4)
        .join(" | ");
    return { erro: detalhe || `wrangler d1 execute saiu com exit ${r.status}` };
  }
  /** @type {any} */
  let dados;
  try {
    dados = JSON.parse(bruto);
  } catch {
    const inicio = bruto.indexOf("[");
    if (inicio >= 0) {
      try {
        dados = JSON.parse(bruto.slice(inicio));
      } catch {
        /* cai no erro abaixo */
      }
    }
  }
  if (dados === undefined) return { erro: "saída do wrangler d1 execute ilegível" };
  if (!Array.isArray(dados)) return { erro: dados?.error?.text || "saída do wrangler d1 execute sem resultados" };
  if (dados[0]?.error?.text) return { erro: dados[0].error.text };
  /** @type {Record<string, string>} */
  const painel = {};
  for (const linha of dados[0]?.results ?? []) painel[linha.key] = linha.value;
  return { painel };
}

/**
 * Caminho do painel: o trio Asaas ausente do Worker precisa estar completo no
 * platform_settings (e decifrável — PAINEL_CHAVE). Não lança: devolve o que
 * registrar (para o chamador aplicar na ordem do relatório).
 *
 * @param {string} ambiente
 * @param {any} cfgEnv bloco do ambiente no wrangler.jsonc
 * @param {string[]} remotos nomes de secrets no Worker
 * @returns {{ ok: string | null, falhas: string[], avisos: string[] }}
 */
function conferirPainel(ambiente, cfgEnv, remotos) {
  const res = { ok: null, falhas: [], avisos: [] };
  const databaseName = cfgEnv.d1_databases?.[0]?.database_name;
  if (!databaseName) {
    res.falhas.push(`wrangler.jsonc: env "${ambiente}" sem d1_databases — não há como conferir o caminho do painel`);
    return res;
  }
  const consulta = consultarPainel(ambiente, databaseName);
  if (consulta.erro) {
    res.falhas.push(
      `credenciais Asaas fora do Worker (${ambiente}) e o painel (${databaseName}) não pôde ser consultado: ${consulta.erro}`,
    );
    return res;
  }
  const { campos, faltando, misto } = resolverTrio(new Set(remotos), consulta.painel);
  if (faltando.length) {
    res.falhas.push(`credenciais Asaas incompletas em "${ambiente}" — nem secret do Worker nem painel: ${faltando.join(", ")}`);
    return res;
  }
  if (!remotos.includes("PAINEL_CHAVE")) {
    res.falhas.push(
      `PAINEL_CHAVE ausente no Worker (${ambiente}) — sem ela o painel não lê nem grava segredo cifrado; ` +
        `defina o secret ou cadastre as credenciais como secret do Worker`,
    );
    return res;
  }
  // presença ok: registra o caminho usado mesmo que as regras de VALOR
  // (abaixo) reprovem — o diagnóstico precisa mostrar que o painel foi lido.
  const viaWorker = TRIO_ASAAS.filter((s) => campos[s].origem === "worker").length;
  res.ok = `credenciais Asaas presentes: ${viaWorker}/3 via secret do Worker, ${3 - viaWorker}/3 via painel (${databaseName})`;
  for (const [segredo, chave] of Object.entries(NO_PAINEL)) {
    if (campos[segredo].origem !== "painel") continue;
    if (!segredoCifrado(chave, consulta.painel[chave])) {
      res.falhas.push(
        `${chave} está em CLARO em platform_settings — segredo do painel exige o prefixo ${PREFIXO_CIFRA}; recadastre pelo painel /saas`,
      );
    }
  }
  const regra = regraAmbiente(ambiente, campos.ASAAS_ENVIRONMENT.origem, campos.ASAAS_ENVIRONMENT.valor);
  if (regra.falha) res.falhas.push(regra.falha);
  if (regra.aviso) res.avisos.push(regra.aviso);
  if (misto.length) {
    res.avisos.push(
      `${misto.join(", ")} presentes NO WORKER e no painel — o secret vence e a edição feita no painel /saas será ignorada`,
    );
  }
  return res;
}

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

function main() {
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
    return;
  }
  if (!ambiente || !AMBIENTES.has(ambiente)) {
    console.error("Uso: node scripts/verificar-secrets.mjs <staging|production|dev> [--sem-remoto]");
    process.exit(2);
  }

  /* --------------------------- wrangler.jsonc ----------------------------- */

  const cfg = JSON.parse(semComentarios(readFileSync(WRANGLER, "utf8")));
  const cfgEnv = cfg.env?.[ambiente] ?? cfg;
  const obrigatorios = cfgEnv.secrets?.required ?? [];
  const vars = cfgEnv.vars ?? {};

  if (obrigatorios.length === 0) {
    falha(`wrangler.jsonc: env "${ambiente}" sem secrets.required — declare os secrets primeiro`);
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
    // 1) presença remota — Worker e, para o trio Asaas, o painel (D1).
    if (semRemoto) {
      aviso("--sem-remoto: presença no Worker e no painel NÃO foi conferida");
    } else {
      const r = execWrangler(["wrangler", "secret", "list", "--env", ambiente]);
      if (r.status !== 0) {
        falha(`wrangler secret list --env ${ambiente} falhou: ${(r.stderr || r.stdout || "").trim().split("\n").slice(-3).join(" | ")}`);
      } else {
        const inicio = r.stdout.indexOf("[");
        const fim = r.stdout.lastIndexOf("]");
        let remotos = null;
        try {
          remotos = JSON.parse(r.stdout.slice(inicio, fim + 1)).map((s) => s.name);
        } catch {
          /* registrado abaixo */
        }
        if (remotos === null) {
          falha("saída do wrangler secret list ilegível — conferir manualmente");
        } else {
          const faltando = obrigatorios.filter((n) => !remotos.includes(n));
          const faltandoTrio = faltando.filter((n) => TRIO_ASAAS.includes(n));
          const faltandoOutros = faltando.filter((n) => !TRIO_ASAAS.includes(n));
          if (faltandoOutros.length) falha(`ausentes no Worker (${ambiente}): ${faltandoOutros.join(", ")}`);
          if (obrigatorios.length && faltandoTrio.length === 0) {
            ok(`todos os ${obrigatorios.length} secrets declarados existem no Worker (${ambiente})`);
          }
          if (faltandoTrio.length) {
            const c = conferirPainel(ambiente, cfgEnv, remotos);
            for (const f of c.falhas) falha(f);
            for (const a of c.avisos) aviso(a);
            if (c.ok) ok(c.ok);
          }
          if (remotos.includes("PAINEL_CHAVE")) {
            ok("PAINEL_CHAVE presente no Worker (chave de cifra do painel /saas)");
          }
          const extras = remotos.filter((n) => !obrigatorios.includes(n) && n !== "PAINEL_CHAVE");
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
}

/** Só executa quando chamado como CLI (os testes importam as funções puras). */
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main();
}
