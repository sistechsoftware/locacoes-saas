import "server-only";
import { one, run } from "./db";

/**
 * Configurações da PLATAFORMA persistidas pelo painel /saas (tabela
 * platform_settings, migration 0038) — lugar para cadastrar as credenciais do
 * Asaas sem exigir terminal.
 *
 * Hierarquia de leitura (a mesma filosofia do resto do billing):
 *   1. secret do Worker (ASAAS_API_KEY / ASAAS_ENVIRONMENT / ASAAS_WEBHOOK_TOKEN)
 *      — quem já opera com secrets continua exatamente igual;
 *   2. valor cadastrado no painel (esta lib);
 *   3. ausente.
 *
 * Segredos no banco NUNCA ficam em claro: gravar `asaas_api_key` ou
 * `asaas_webhook_token` exige o secret PAINEL_CHAVE do Worker (32 bytes em
 * qualquer formato — é hasheado com SHA-256 para a chave AES-GCM). Sem essa
 * chave a gravação de segredo é RECUSADA: banco exportado (backup D1 em R2)
 * não pode virar vazamento de token de cobrança. Valores não-sensíveis
 * (ambiente sandbox/production) ficam em claro de propósito — o painel mostra
 * o estado deles.
 */

/* -------------------------------------------------------------------------- */
/* Chaves                                                                      */
/* -------------------------------------------------------------------------- */

/** Segredos: gravados cifrados (AES-GCM) e nunca exibidos de volta. */
const SEGREDOS = new Set(["asaas_api_key", "asaas_webhook_token"]);
/** Não-sensíveis: valor legível pelo painel. */
const TEXTOS = new Set(["asaas_environment"]);

export type ChavePlataforma = "asaas_api_key" | "asaas_environment" | "asaas_webhook_token";

export function ehSegredo(chave: string): boolean {
  return SEGREDOS.has(chave);
}

function chaveValida(chave: string): asserts chave is ChavePlataforma {
  if (!SEGREDOS.has(chave) && !TEXTOS.has(chave)) {
    throw new Error(`Chave de configuração da plataforma desconhecida: ${chave}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Cifra AES-GCM (WebCrypto — existe no Worker e no Node 22)                   */
/* -------------------------------------------------------------------------- */

const PREFIXO = "enc:v1:";

/**
 * Gancho de teste (mesmo padrão de `__limasTestDb` / `__definirAsaasTeste`):
 * define a chave de cifra usada sem tocar em secret. Em produção fica null e
 * a lib lê PAINEL_CHAVE do Worker.
 */
let chavePainelTeste: string | null = null;
export function __definirChavePainelTeste(chave: string | null) {
  chavePainelTeste = chave;
}

/** Lê PAINEL_CHAVE do secret do Worker. Null quando ausente/inacessível. */
async function lerChaveCifra(): Promise<string | null> {
  if (chavePainelTeste !== null) return chavePainelTeste;
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    return getCloudflareContext().env.PAINEL_CHAVE ?? null;
  } catch {
    return null;
  }
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function unbase64(texto: string): Uint8Array {
  const bin = atob(texto);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Chave AES-GCM de 32 bytes derivada do segredo (qualquer formato serve). */
async function chaveAes(bruta: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bruta));
  return await crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function cifrarValor(texto: string): Promise<string> {
  const bruta = await lerChaveCifra();
  if (!bruta) throw new Error(SEM_CHAVE_MSG);
  const chave = await chaveAes(bruta);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, chave, new TextEncoder().encode(texto));
  const pacote = new Uint8Array(iv.length + ct.byteLength);
  pacote.set(iv, 0);
  pacote.set(new Uint8Array(ct), iv.length);
  return `${PREFIXO}${base64(pacote)}`;
}

export async function decifrarValor(pacote: string): Promise<string | null> {
  if (!pacote.startsWith(PREFIXO)) return pacote; // valor não-sensível (em claro)
  const bruta = await lerChaveCifra();
  if (!bruta) {
    console.warn("[platform-settings] PAINEL_CHAVE ausente — segredo cifrado ilegível");
    return null;
  }
  const bin = unbase64(pacote.slice(PREFIXO.length));
  if (bin.length <= 12) return null;
  const chave = await chaveAes(bruta);
  try {
    const claro = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bin.slice(0, 12) },
      chave,
      bin.slice(12),
    );
    return new TextDecoder().decode(claro);
  } catch {
    console.warn("[platform-settings] falha ao decifrar segredo (PAINEL_CHAVE trocada?)");
    return null;
  }
}

const SEM_CHAVE_MSG =
  "PAINEL_CHAVE (secret do Worker) ausente — defina com " +
  "`wrangler secret put PAINEL_CHAVE --env <ambiente>` antes de cadastrar segredos no painel.";

/* -------------------------------------------------------------------------- */
/* Persistência                                                                */
/* -------------------------------------------------------------------------- */

/** Valor ABERTO (decifrado) da chave, ou null se ausente/ilegível. */
export async function lerConfig(chave: ChavePlataforma): Promise<string | null> {
  chaveValida(chave);
  const linha = await one<{ value: string }>(`SELECT value FROM platform_settings WHERE key = ?`, [chave]);
  if (!linha) return null;
  return await decifrarValor(linha.value);
}

/** Valor BRUTO gravado (para o painel decidir se "já foi cadastrado"). */
export async function configGravada(chave: ChavePlataforma): Promise<boolean> {
  chaveValida(chave);
  const linha = await one<{ value: string }>(`SELECT value FROM platform_settings WHERE key = ?`, [chave]);
  return !!linha;
}

/**
 * Grava (ou remove, com valor vazio) uma configuração da plataforma.
 * Segredo exige PAINEL_CHAVE — recusa em vez de gravar em claro.
 */
export async function gravarConfig(chave: ChavePlataforma, valor: string | null): Promise<void> {
  chaveValida(chave);
  const limpo = (valor ?? "").trim();

  if (!limpo) {
    await run(`DELETE FROM platform_settings WHERE key = ?`, [chave]);
    return;
  }

  if (chave === "asaas_environment" && limpo !== "sandbox" && limpo !== "production") {
    throw new Error('Ambiente do Asaas só pode ser "sandbox" ou "production".');
  }

  const guardado = ehSegredo(chave) ? await cifrarValor(limpo) : limpo;
  await run(
    `INSERT INTO platform_settings (key, value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')`,
    [chave, guardado],
  );
}

/* -------------------------------------------------------------------------- */
/* Resolução das credenciais do Asaas (secret do Worker > painel > ausente)    */
/* -------------------------------------------------------------------------- */

export type CredenciaisAsaas = {
  apiKey: string | null;
  environment: string | null;
  webhookToken: string | null;
  /** De onde veio cada valor — para o painel mostrar sem expor o valor. */
  origem: {
    apiKey: "worker" | "painel" | "ausente";
    environment: "worker" | "painel" | "ausente";
    webhookToken: "worker" | "painel" | "ausente";
  };
};

/** Lê um valor do secret do Worker sem lançar (fora do Worker = null). */
async function segredoWorker(
  nome: "ASAAS_API_KEY" | "ASAAS_ENVIRONMENT" | "ASAAS_WEBHOOK_TOKEN",
): Promise<string | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = getCloudflareContext().env;
    return env[nome] ?? null;
  } catch {
    return null;
  }
}

export async function credenciaisAsaas(): Promise<CredenciaisAsaas> {
  const [wKey, wEnv, wToken] = await Promise.all([
    segredoWorker("ASAAS_API_KEY"),
    segredoWorker("ASAAS_ENVIRONMENT"),
    segredoWorker("ASAAS_WEBHOOK_TOKEN"),
  ]);
  const [pKey, pEnv, pToken] = await Promise.all([
    lerConfig("asaas_api_key"),
    lerConfig("asaas_environment"),
    lerConfig("asaas_webhook_token"),
  ]);

  const resolver = (worker: string | null, painel: string | null) => {
    if (worker) return { valor: worker, origem: "worker" as const };
    if (painel) return { valor: painel, origem: "painel" as const };
    return { valor: null, origem: "ausente" as const };
  };

  const key = resolver(wKey, pKey);
  const env = resolver(wEnv, pEnv);
  const token = resolver(wToken, pToken);

  return {
    apiKey: key.valor,
    environment: env.valor,
    webhookToken: token.valor,
    origem: { apiKey: key.origem, environment: env.origem, webhookToken: token.origem },
  };
}
