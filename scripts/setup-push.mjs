/** One-time setup. Secrets go directly to Wrangler stdin; never printed or written to disk. */
import { createECDH } from "node:crypto";
import { spawnSync } from "node:child_process";

const listed = spawnSync("npx",["wrangler","secret","list"],{encoding:"utf8"});
if (listed.status!==0) throw new Error("Nao foi possivel verificar secrets. Confira wrangler whoami.");
const secrets = JSON.parse(listed.stdout);
if (secrets.some(s=>s.name==="VAPID_PUBLIC_KEY" || s.name==="VAPID_PRIVATE_KEY")) {
  throw new Error("Ja existem chaves VAPID. Nao foram alteradas: rotacionar invalida inscricoes existentes.");
}
const ec = createECDH("prime256v1");
ec.generateKeys();
const result = spawnSync("npx",["wrangler","secret","bulk"],{
  input:JSON.stringify({VAPID_PUBLIC_KEY:ec.getPublicKey().toString("base64url"),VAPID_PRIVATE_KEY:ec.getPrivateKey().toString("base64url")}),
  encoding:"utf8",
});
if (result.status!==0) { console.error("Falha ao configurar secrets. Confira os nomes com wrangler secret list antes de tentar novamente."); process.exit(1); }
console.log("Par VAPID configurado com seguranca na Cloudflare. Valores nao exibidos.");
