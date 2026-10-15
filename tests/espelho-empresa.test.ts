/**
 * Espelho dos dados cadastrais da empresa em `companies`.
 *
 * Cobre a ponte Configurações → Empresa → companies e o backfill da migration
 * 0040:
 *  - o salvamento espelha os SETE campos (nome, documento, e-mail, telefone,
 *    whatsapp, endereço e cidade) — não só documento/e-mail como antes;
 *  - documento chega só com dígitos (máscara removida), como a cobrança exige;
 *  - vazio NÃO sobrescreve documento/e-mail (protege o que o onboarding
 *    gravou direto em companies), mas nome/telefone/endereço/cidade são
 *    espelhados incondicionalmente (limpar na tela limpa no espelho);
 *  - o espelho é SEMPRE da empresa informada (contexto da sessão), nunca de
 *    outra;
 *  - a migration 0040 sincroniza o histórico sem sobrescrever com vazio e é
 *    idempotente em valores.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb, resetTestDb, type FakeD1 } from "./helpers/d1.ts";
import { insert, one, run, resetCompanyCache } from "../src/lib/db.ts";
import { espelharDadosEmpresa } from "../src/lib/espelho-empresa.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRACAO = path.join(ROOT, "migrations", "0040_espelho_empresa_companies.sql");

let db: FakeD1;

beforeEach(() => {
  resetTestDb();
  resetCompanyCache();
  db = createTestDb();
});

async function empresas(companyId: number) {
  return await one<any>(
    `SELECT name, document, email, phone, whatsapp, address, city FROM companies WHERE id = ?`,
    [companyId],
  );
}

describe("espelho em companies a cada salvamento (saveCompanySettings)", () => {
  it("espelha os sete campos cadastrais e avança updated_at", async () => {
    await run(`UPDATE companies SET updated_at = '2020-01-01 00:00:00' WHERE id = 1`);
    await espelharDadosEmpresa(1, {
      name: "Uériclis Locações",
      document: "124.244.796-23",
      email: "contato@uericlis.com.br",
      phone: "(34) 98888-0001",
      whatsapp: "(34) 98888-0002",
      address: "Rua das Flores, 100",
      city: "Uberlândia/MG",
    });
    const c = await empresas(1);
    assert.equal(c.name, "Uériclis Locações");
    assert.equal(c.document, "12424479623", "documento tem que sair só com dígitos");
    assert.equal(c.email, "contato@uericlis.com.br");
    assert.equal(c.phone, "(34) 98888-0001");
    assert.equal(c.whatsapp, "(34) 98888-0002");
    assert.equal(c.address, "Rua das Flores, 100");
    assert.equal(c.city, "Uberlândia/MG");
    const u = await one<any>(`SELECT updated_at FROM companies WHERE id = 1`);
    assert.notEqual(u.updated_at, "2020-01-01 00:00:00", "updated_at tem que avançar no espelho");
  });

  it("documento/e-mail vazios preservam o valor que o onboarding gravou", async () => {
    // mesmo cenário do onboarding PJ: companies.document preenchido direto,
    // company_doc no KV ainda vazio — o formulário mostra o campo em branco
    await run(`UPDATE companies SET document = '11144477735', email = 'dono@empresa.com' WHERE id = 1`);
    await espelharDadosEmpresa(1, {
      name: "Nome Novo",
      document: "   ",
      email: "",
      phone: "",
      whatsapp: "",
      address: "",
      city: "",
    });
    const c = await empresas(1);
    assert.equal(c.document, "11144477735", "vazio não pode apagar o documento do onboarding");
    assert.equal(c.email, "dono@empresa.com", "vazio não pode apagar o e-mail do onboarding");
    assert.equal(c.name, "Nome Novo", "nome continua sendo espelhado");
  });

  it("nome/telefone/endereço/cidade vazios são espelhados (limpar na tela limpa no espelho)", async () => {
    await espelharDadosEmpresa(1, {
      name: "",
      document: "",
      email: "",
      phone: "",
      whatsapp: "",
      address: "",
      city: "",
    });
    const c = await empresas(1);
    assert.equal(c.name, "", "form é o único escritor de name: vazio espelha vazio");
    assert.equal(c.phone, "");
    assert.equal(c.whatsapp, "");
    assert.equal(c.address, "");
    assert.equal(c.city, "");
  });

  it("o espelho é da empresa da sessão: a empresa 2 fica intacta", async () => {
    await insert(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa B', 1)`);
    await espelharDadosEmpresa(1, {
      name: "Só da A",
      document: "11122233344",
      email: "a@a.com",
      phone: "1111",
      whatsapp: "2222",
      address: "Rua A",
      city: "Cidade A",
    });
    const b = await empresas(2);
    assert.equal(b.name, "Empresa B", "espelho da A não pode tocar na B");
    assert.equal(b.phone, null);
    assert.equal(b.document, null);
  });
});

describe("backfill da migration 0040", () => {
  function rodarBackfill() {
    db.sqlite.exec(fs.readFileSync(MIGRACAO, "utf8"));
  }

  it("sincroniza companies com o que a tela mostra (company_settings é a fonte visível)", async () => {
    // cenário real da auditoria: nome do onboarding em companies, nome novo no KV
    await run(`UPDATE companies SET name = 'Uériclis Lima' WHERE id = 1`);
    await run(
      `INSERT INTO company_settings (company_id, key, value) VALUES
         (1, 'company_name', 'UÉRICLIS LOCAÇÕES E EVENTOS'),
         (1, 'company_phone', '(34) 98888-0001'),
         (1, 'company_whatsapp', '(34) 98888-0002'),
         (1, 'company_address', 'Rua das Flores, 100'),
         (1, 'company_city', ''),
         (1, 'company_doc', '016.676.986-05'),
         (1, 'company_email', 'novo@email.com')`,
    );
    // cidade já preenchida no cadastro com valor antigo: KV vazio não pisa
    await run(`UPDATE companies SET city = 'Cidade Antiga' WHERE id = 1`);

    rodarBackfill();

    const c = await empresas(1);
    assert.equal(c.name, "UÉRICLIS LOCAÇÕES E EVENTOS", "nome do KV é o que a tela mostra");
    assert.equal(c.phone, "(34) 98888-0001");
    assert.equal(c.whatsapp, "(34) 98888-0002");
    assert.equal(c.address, "Rua das Flores, 100");
    assert.equal(c.city, "Cidade Antiga", "KV vazio não sobrescreve o cadastro");
    assert.equal(c.document, "01667698605", "documento normalizado só com dígitos");
    assert.equal(c.email, "novo@email.com");
  });

  it("documento/e-mail do onboarding sobrevivem quando o KV está vazio", async () => {
    await run(`UPDATE companies SET document = '11144477735', email = 'dono@empresa.com' WHERE id = 1`);
    await run(
      `INSERT INTO company_settings (company_id, key, value) VALUES (1, 'company_name', 'Nome Novo'), (1, 'company_doc', ''), (1, 'company_email', '')`,
    );

    rodarBackfill();

    const c = await empresas(1);
    assert.equal(c.document, "11144477735");
    assert.equal(c.email, "dono@empresa.com");
    assert.equal(c.name, "Nome Novo");
  });

  it("é idempotente em valores: rodar duas vezes não muda nada", async () => {
    await run(
      `INSERT INTO company_settings (company_id, key, value) VALUES (1, 'company_name', 'Nome Estável'), (1, 'company_phone', '34999990000')`,
    );

    rodarBackfill();
    const depois1 = await empresas(1);
    rodarBackfill();
    const depois2 = await empresas(1);

    assert.deepEqual(depois2, depois1, "segunda execução não altera valores");
    assert.equal(depois2.name, "Nome Estável");
  });

  it("empresa sem nenhuma identidade no KV não é tocada", async () => {
    await insert(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa B', 1)`);
    await run(`UPDATE companies SET name = 'Empresa B' WHERE id = 2`);
    await run(`INSERT INTO company_settings (company_id, key, value) VALUES (1, 'company_name', 'Só da A')`);

    rodarBackfill();

    const b = await empresas(2);
    assert.equal(b.name, "Empresa B");
    assert.equal(b.phone, null);
    assert.equal(b.document, null);
  });
});

/* ------------------------------------------------------------------ */
/* Contrato da action: a ponte tela → companies precisa ser COMPLETA   */
/* ------------------------------------------------------------------ */

describe("action saveCompanySettings usa o espelho completo", () => {
  const fonte = fs.readFileSync(
    path.join(ROOT, "src/app/(app)/configuracoes/actions.ts"),
    "utf8",
  );

  it("a action chama espelharDadosEmpresa com os sete campos", () => {
    assert.ok(
      fonte.includes("espelharDadosEmpresa("),
      "saveCompanySettings precisa espelhar via lib/espelho-empresa.ts",
    );
    for (const campo of [
      "name: values.company_name",
      "document: values.company_doc",
      "email: values.company_email",
      "phone: values.company_phone",
      "whatsapp: values.company_whatsapp",
      "address: values.company_address",
      "city: values.company_city",
    ]) {
      assert.ok(fonte.includes(campo), `espelho sem o campo ${campo}`);
    }
  });

  it("os UPDATEs parciais inline (só document/email) sumiram da action", () => {
    assert.ok(
      !fonte.includes("UPDATE companies SET document"),
      "espelho parcial inline voltou — o lugar da escrita é lib/espelho-empresa.ts",
    );
    assert.ok(!fonte.includes("const docLimpo"), "guardião antigo de documento sumiu da action");
  });
});
