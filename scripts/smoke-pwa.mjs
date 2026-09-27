/** Run after the OpenNext build. Uses an isolated local D1, never production data. */
import { spawnSync, spawn } from "node:child_process";
import { createECDH, randomBytes, scryptSync } from "node:crypto";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(process.env.BROWSER_MODULES_DIR ? `${process.env.BROWSER_MODULES_DIR}/package.json` : import.meta.url);
const { chromium } = require("playwright");
const temporary = spawnSync("mktemp",["-d","/tmp/limas-pwa-smoke.XXXXXX"],{encoding:"utf8"}).stdout.trim();
if (!temporary.startsWith("/tmp/limas-pwa-smoke.")) throw Error("Diretorio de teste invalido.");
const command = args => {
  const result=spawnSync("npx",["wrangler",...args],{encoding:"utf8"});
  if(result.status!==0) throw Error(result.stderr||result.stdout);
  return result.stdout;
};
const sql = statement => command(["d1","execute","limas-locacoes","--local","--persist-to",temporary,"--command",statement]);
command(["d1","migrations","apply","limas-locacoes","--local","--persist-to",temporary]);
const password=randomBytes(18).toString("hex"),salt=randomBytes(16).toString("hex");
const hash=`scrypt$${salt}$${scryptSync(password,salt,64).toString("hex")}`;
sql(`INSERT INTO users(id,name,username,password_hash,role) VALUES (1,'Smoke Admin','smoke','${hash}','admin');
 INSERT INTO user_operational_roles VALUES (1,'entregador');
 INSERT INTO activities(source,source_id,kind,title,scheduled_at,link) VALUES ('smoke',1,'entrega','Entrega de teste','2030-01-01T08:00','/notificacoes/atividades');`);
const ec=createECDH("prime256v1");ec.generateKeys();
const proc=spawn("npx",["wrangler","dev","--port","8791","--test-scheduled","--persist-to",temporary],{
  env:{...process.env,VAPID_PUBLIC_KEY:ec.getPublicKey().toString("base64url"),VAPID_PRIVATE_KEY:ec.getPrivateKey().toString("base64url")},stdio:["ignore","pipe","pipe"],detached:true,
});
let logs="";proc.stdout.on("data",b=>logs+=b);proc.stderr.on("data",b=>logs+=b);
const base="http://localhost:8791";
let browser;
try {
  let ready=false;
  for(let i=0;i<60;i++){try{const r=await fetch(base+"/login");if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
  if(!ready)throw Error("Preview nao iniciou: "+logs.slice(-3000));
  browser=await chromium.launch({headless:true,channel:process.env.BROWSER_CHANNEL || undefined});
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  const errors=[];page.on("pageerror",e=>errors.push(e.message));
  await page.goto(base+"/login");
  await page.locator('[name="username"]').fill("smoke");
  await page.locator('[name="password"]').fill(password);
  await page.getByRole("button",{name:/entrar/i}).click();
  await page.waitForURL("**/dashboard");
  console.log("Login real: OK");
  await page.goto(base+"/notificacoes/preferencias");
  await page.getByRole("heading",{name:"Preferencias de notificacao"}).waitFor();
  assert.equal(await page.evaluate(()=>Notification.permission),"default","Nao pode pedir permissao automaticamente");
  await page.evaluate(()=>navigator.serviceWorker.ready.then(()=>true));
  console.log("PWA registrado sem pedir permissao: OK");
  await page.screenshot({path:temporary+"/preferencias-mobile.png",fullPage:true});
  const cron=await fetch(base+"/__scheduled");assert.equal(cron.status,200);
  await page.goto(base+"/notificacoes");
  await page.getByRole("heading",{name:"Novo agendamento: Entrega de teste"}).waitFor();
  await page.getByRole("button",{name:"Marcar como lida",exact:true}).click();
  await page.getByText(/0 nao lida/).waitFor();
  console.log("Cron real workerd → D1 → central → marcar lida: OK");
  for(const route of ["/fretes/novo","/reservas/nova","/orcamentos/novo","/configuracoes?aba=frete","/notificacoes/atividades"]){
    const response=await page.goto(base+route);assert.equal(response.status(),200,route);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`Overflow mobile: ${route}`);
  }
  await page.goto(base+"/fretes/novo");
  const amount=page.locator('[name="amount"]');await amount.fill("123.45");
  await page.getByLabel("Calcular frete por endereco").check();
  await page.getByRole("button",{name:"Calcular rota",exact:true}).click();
  await page.getByRole("alert").filter({hasText:/endereco-base/}).waitFor();
  assert.equal(await amount.inputValue(),"123.45");
  console.log("Base ausente: erro visivel e preco manual preservado: OK");
  const unauth=await fetch(base+"/api/push");assert.equal(unauth.status,401);
  const csrf=await context.request.post(base+"/api/push",{data:{action:"disable",id:1},headers:{Origin:"https://attacker.invalid"}});assert.equal(csrf.status(),401);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:"PASS",screenshots:temporary,browserErrors:errors}));
} finally {
  if(browser)await browser.close();
  try{process.kill(-proc.pid,"SIGTERM");}catch{}
}
