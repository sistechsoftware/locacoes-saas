/** Browser + real workerd/D1 smoke. Isolated temp database; never production. */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, scryptSync, createECDH } from "node:crypto";
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(process.env.BROWSER_MODULES_DIR ? `${process.env.BROWSER_MODULES_DIR}/package.json` : import.meta.url);
const { chromium } = require("playwright");
const temporary = spawnSync("mktemp", ["-d", "/tmp/limas-stock-smoke.XXXXXX"], { encoding: "utf8" }).stdout.trim();
assert.ok(temporary.startsWith("/tmp/limas-stock-smoke."));
const command = (args) => {
  const r = spawnSync(process.execPath, ["node_modules/wrangler/bin/wrangler.js", ...args], { encoding: "utf8", env: { ...process.env, WRANGLER_LOG_PATH: temporary + "/logs", CI: "1" } });
  if (r.status !== 0) throw Error(r.stderr + r.stdout);
  return r.stdout;
};
const sql = (s) => command(["d1", "execute", "limas-locacoes", "--local", "--persist-to", temporary, "--command", s]);
command(["d1", "migrations", "apply", "limas-locacoes", "--local", "--persist-to", temporary]);
const password = randomBytes(18).toString("hex"), salt = randomBytes(16).toString("hex");
const hash = `scrypt$${salt}$${scryptSync(password,salt,64).toString("hex")}`;
sql(`INSERT INTO users(id,name,username,password_hash,role) VALUES(1,'Auditoria Admin','auditoria','${hash}','admin');
INSERT INTO customers(id,name) VALUES(1,'Cliente de teste');
INSERT INTO products(id,code,name,kind,total_qty,rent_price_cents) VALUES(1,'MESA','Mesa teste','simples',5,1000),(2,'CAD','Cadeira teste','simples',20,500),(3,'KIT','Kit teste','kit',0,3000);
INSERT INTO product_components(parent_product_id,component_product_id,quantity) VALUES(3,1,1),(3,2,4);
INSERT INTO reservations(id,number,customer_id,status,event_date,delivery_at,pickup_at) VALUES(1,'LIMA-001',1,'confirmada','2026-09-06','2026-09-06T13:00','2026-09-07T13:00');
INSERT INTO reservation_items(id,reservation_id,product_id,qty,unit_price_cents) VALUES(1,1,3,5,3000);
INSERT INTO reservation_item_components(reservation_id,reservation_item_id,product_id,qty_per_unit,qty) VALUES(1,1,1,1,5),(1,1,2,4,20);
INSERT INTO quotes(id,number,customer_id,event_date,delivery_at,pickup_at) VALUES(1,'ORC-001',1,'2026-09-07','2026-09-07T14:00','2026-09-07T18:00');
INSERT INTO quote_items(quote_id,product_id,qty,unit_price_cents) VALUES(1,3,5,3000);
UPDATE settings SET value='120' WHERE key='stock_preparation_minutes';`);
const ec = createECDH("prime256v1"); ec.generateKeys();
const proc = spawn(process.execPath, ["node_modules/wrangler/bin/wrangler.js", "dev", "--port", "8792", "--persist-to", temporary], {
  detached: true, stdio: ["ignore","pipe","pipe"], env: { ...process.env, WRANGLER_LOG_PATH: temporary + "/logs", VAPID_PUBLIC_KEY: ec.getPublicKey().toString("base64url"), VAPID_PRIVATE_KEY: ec.getPrivateKey().toString("base64url") },
});
let logs = ""; proc.stdout.on("data", b => logs += b); proc.stderr.on("data", b => logs += b);
const base = "http://localhost:8792";
let browser;
try {
  let ready = false;
  for (let i=0;i<90;i++) { try { if ((await fetch(base + "/login")).ok) { ready=true; break; } } catch {} await new Promise(r=>setTimeout(r,500)); }
  if (!ready) throw Error(logs.slice(-4000));
  browser = await chromium.launch({ headless:true, channel:process.env.BROWSER_CHANNEL || "chrome" });
  const context = await browser.newContext({ viewport:{width:390,height:844} });
  const page = await context.newPage();
  const errors = []; page.on("pageerror",e=>errors.push(e.message));
  const go = async (route) => { const r = await page.goto(base + route); assert.equal(r.status(),200,route); };
  await go("/login");
  await page.locator('[name="username"]').fill("auditoria");
  await page.locator('[name="password"]').fill(password);
  await page.getByRole("button",{name:/entrar/i}).click();
  await page.waitForURL("**/dashboard");
  console.log("Login real: OK");
  for (const [h,prep,count] of [["12:59",0,0],["13:00",0,5],["14:59",1,0],["15:00",1,5]]) {
    const qs = new URLSearchParams({inicio:`2026-09-07T${h}`,preparo:String(prep)}).toString();
    for (const route of ["/disponibilidade","/estoque","/dashboard","/estoque/3"]) {
      await go(route + "?" + qs);
      await page.getByText("Considerar tempo de deslocamento e higienizacao",{exact:true}).waitFor();
      const body = await page.locator("body").innerText();
      assert.ok(body.includes(h),`${route} mostra horario`);
      if(route !== "/estoque/3") {
        const kit = page.locator('a[href^="/estoque/3?"]').first();
        const text = await kit.innerText();
        assert.match(text,new RegExp(`(^|\\s)${count}(\\s|$)`),`${route}: ${text}`);
      }
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow ${route}`);
    }
  }
  console.log("Painel, estoque, disponibilidade e ficha: horarios e limites consistentes, sem overflow mobile");
  await go("/disponibilidade?inicio=2026-09-07T14%3A00&preparo=1");
  await page.getByRole("checkbox",{name:"Considerar tempo de deslocamento e higienizacao"}).uncheck();
  await page.getByRole("button",{name:"Consultar",exact:true}).click();
  await page.waitForURL(/consulta=1/);
  assert.match(await page.locator('a[href^="/estoque/3?"]').innerText(),/\b5\b/);
  await page.locator('a[href^="/estoque/3?"]').click();
  assert.equal(await page.getByRole("checkbox",{name:"Considerar tempo de deslocamento e higienizacao"}).isChecked(),false);
  console.log("Checkbox GET desmarcado e navegacao entre telas: OK");
  await go("/orcamentos/1/editar");
  await page.getByText("Atencao: estoque apertado neste intervalo",{exact:true}).waitFor();
  await page.locator('[name="delivery_at"]').fill("2026-09-07T15:00");
  await page.getByText("Atencao: estoque apertado neste intervalo",{exact:true}).waitFor({state:"hidden"});
  await page.locator('[name="delivery_at"]').fill("2026-09-07T14:00");
  await page.getByText("Atencao: estoque apertado neste intervalo",{exact:true}).waitFor();
  await page.getByRole("checkbox",{name:"Considerar tempo de deslocamento e higienizacao"}).uncheck();
  await page.getByText("Atencao: estoque apertado neste intervalo",{exact:true}).waitFor({state:"hidden"});
  console.log("Orcamento responde aos horarios reais e a flag: OK");
  await page.locator('[name="delivery_at"]').fill("2026-09-08T14:00");
  await page.locator('[name="pickup_at"]').fill("2026-09-08T18:00");
  await page.getByRole("button",{name:"Salvar alteracoes",exact:true}).click();
  await page.waitForURL("**/orcamentos/1");
  await page.getByRole("button",{name:"Converter orcamento em reserva"}).click();
  await page.waitForURL(/\/reservas\/\d+$/);
  const converted = page.url();
  assert.equal(await page.getByRole("checkbox",{name:"Considerar tempo de deslocamento e higienizacao"}).isChecked(),false);
  console.log("Salvar orcamento e converter com preferencia preservada: OK");
  await go("/reservas/nova");
  await page.locator('[name="customer_id"]').selectOption("1");
  await page.locator('[name="event_date"]').fill("2026-09-07");
  await page.locator('[name="delivery_at"]').fill("2026-09-07T15:00");
  await page.locator('[name="pickup_at"]').fill("2026-09-07T18:00");
  await page.locator("select").filter({has:page.locator('option[value="3"]')}).last().selectOption("3");
  await page.getByRole("button",{name:"Criar reserva",exact:true}).click();
  await page.waitForURL(/\/reservas\/\d+$/);
  const created = page.url();
  await page.getByRole("link",{name:"Editar",exact:true}).click();
  await page.locator('[name="delivery_at"]').fill("2026-09-07T14:00");
  await page.getByRole("checkbox",{name:"Considerar tempo de deslocamento e higienizacao"}).uncheck();
  await page.getByRole("button",{name:"Salvar alteracoes",exact:true}).click();
  await page.waitForURL(created);
  assert.equal(await page.getByRole("checkbox",{name:"Considerar tempo de deslocamento e higienizacao"}).isChecked(),false);
  console.log("Criar e editar reserva via Server Actions reais: OK");
  for(const route of ["/reservas/1/editar","/orcamentos/novo","/notificacoes/alertas","/configuracoes?aba=disponibilidade"]) {
    await go(route);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`overflow ${route}`);
  }
  await page.locator('[name="stock_preparation_minutes"]').fill("30");
  await page.getByRole("button",{name:"Salvar configuracao"}).click();
  await page.reload();
  assert.equal(await page.locator('[name="stock_preparation_minutes"]').inputValue(),"30");
  await go("/disponibilidade?inicio=2026-09-07T13%3A30&preparo=1");
  assert.match(await page.locator('a[href^="/estoque/3?"]').innerText(),/\b5\b/);
  await page.screenshot({path:temporary+"/disponibilidade-mobile.png",fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.screenshot({path:temporary+"/disponibilidade-desktop.png",fullPage:true});
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({result:"PASS",browserErrors:errors,temporary,created,converted}));
} catch(e) {
  console.error(logs.slice(-8000)); throw e;
} finally {
  if(browser) await browser.close();
  try { process.kill(-proc.pid,"SIGTERM"); } catch {}
}
