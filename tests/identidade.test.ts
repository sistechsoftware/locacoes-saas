/**
 * Identidade de cadastro/login (migração 0037):
 *  - validação pura de CPF/CNPJ/e-mail e classificação de identificador;
 *  - localização de conta por identificador (ambiguidade nunca vira login);
 *  - unicidade de documento/e-mail no BACKEND e no índice do banco;
 *  - migração não destrutiva: conta legada preservada, campos NULL;
 *  - criação de usuário recusa tudo que a interface possa ser contornada.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb, FakeD1, resetTestDb } from "./helpers/d1.ts";
import { all, insert, one, resetCompanyCache, run, scalar } from "../src/lib/db.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

beforeEach(async () => {
  resetTestDb();
  resetCompanyCache();
  createTestDb();
  await run(`DELETE FROM users`);
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, active, company_id, email)
     VALUES (1, 'João', 'joao', 'hash', 'owner', 1, 1, 'Joao@X.com')`,
  );
});

/* ------------------------- validação pura ------------------------- */

describe("identidade: validação de CPF/CNPJ/e-mail", async () => {
  const { cpfValido, cnpjValido, documentoDoTipo, emailValido, tipoPessoaValido } =
    await import("../src/lib/identidade.ts");

  it("aceita CPFs/CNPJs válidos e recusa inválidos (dígito verificador)", () => {
    assert.ok(cpfValido("11144477735"));
    assert.ok(cpfValido("111.444.777-35"));
    assert.ok(cpfValido("52998224725"));
    assert.ok(cpfValido("12345678909"));
    assert.ok(!cpfValido("11144477736"), "DV errado");
    assert.ok(!cpfValido("11111111111"), "sequência repetida");
    assert.ok(!cpfValido("1234567890"), "tamanho errado");

    assert.ok(cnpjValido("11222333000181"));
    assert.ok(cnpjValido("11.222.333/0001-81"));
    assert.ok(cnpjValido("00000000000191"));
    assert.ok(!cnpjValido("11222333000182"), "DV errado");
    assert.ok(!cnpjValido("11144477735"), "14 dígitos exigidos no CNPJ");
    assert.ok(!cnpjValido("00000000000000"), "sequência repetida");
  });

  it("documentoDoTipo exige coerência entre tipo e documento", () => {
    const pf = documentoDoTipo("pf", "111.444.777-35");
    assert.ok(pf.ok);
    if (pf.ok) assert.equal(pf.documento, "11144477735", "normaliza para só dígitos");

    assert.ok(!documentoDoTipo("pf", "11222333000181").ok, "CNPJ não vale como CPF");
    assert.ok(!documentoDoTipo("pj", "11144477735").ok, "CPF não vale como CNPJ");
    assert.ok(!documentoDoTipo(null, "11144477735").ok, "tipo ausente é recusado");
    assert.ok(!documentoDoTipo("pf", "").ok, "documento ausente é recusado");
    assert.ok(!documentoDoTipo("x" as any, "11144477735").ok, "tipo lixo é recusado");
  });

  it("e-mail: formato validado e tipo de pessoa normalizado", () => {
    assert.ok(emailValido("voce@empresa.com"));
    assert.ok(emailValido("voce+tag@sub.dom.com.br"));
    assert.ok(!emailValido(""));
    assert.ok(!emailValido("sem-arroba"));
    assert.ok(!emailValido("a@b"));
    assert.ok(!emailValido("a b@c.com"));
    assert.equal(tipoPessoaValido("PF"), "pf");
    assert.equal(tipoPessoaValido("pj"), "pj");
    assert.equal(tipoPessoaValido("Pessoa Jurídica"), "pj");
    assert.equal(tipoPessoaValido(""), null);
    assert.equal(tipoPessoaValido("x"), null);
  });
});

describe("identidade: classificação de identificador de login", async () => {
  const { classificarIdentificador } = await import("../src/lib/identidade.ts");

  it("detecta e-mail, CPF, CNPJ e usuário legado sem perguntar", () => {
    assert.deepEqual(classificarIdentificador("Voce@Empresa.COM"), { tipo: "email", valor: "voce@empresa.com" });
    assert.deepEqual(classificarIdentificador("111.444.777-35"), { tipo: "documento", valor: "11144477735" });
    assert.deepEqual(classificarIdentificador("11144477735"), { tipo: "documento", valor: "11144477735" });
    assert.deepEqual(classificarIdentificador("11.222.333/0001-81"), { tipo: "documento", valor: "11222333000181" });
    assert.deepEqual(classificarIdentificador("admin"), { tipo: "usuario", valor: "admin" });
    assert.deepEqual(classificarIdentificador("JOAO"), { tipo: "usuario", valor: "joao" });
    assert.deepEqual(classificarIdentificador("12345"), { tipo: "usuario", valor: "12345" }, "5 dígitos = usuário");
    assert.deepEqual(classificarIdentificador("abc12345678901"), { tipo: "usuario", valor: "abc12345678901" });
    assert.deepEqual(classificarIdentificador(""), { tipo: "usuario", valor: "" });
  });
});

/* --------------------- localização de conta --------------------- */

describe("localizarConta: login/recuperação por identificador", async () => {
  const { localizarConta } = await import("../src/lib/contas.ts");

  beforeEach(async () => {
    // PF com CPF + e-mail (case misto de propósito), PJ com CNPJ, legado sem
    // documento/e-mail e um username numérico de 11 dígitos.
    await run(
      `INSERT INTO users (id, name, username, password_hash, role, active, company_id, email, person_type, document)
       VALUES (2, 'Maria PF', 'maria', 'h', 'operacional', 1, 1, 'Maria@Pf.com', 'pf', '52998224725')`,
    );
    await run(
      `INSERT INTO users (id, name, username, password_hash, role, active, company_id, email, person_type, document)
       VALUES (3, 'Empresa PJ', 'empresa', 'h', 'owner', 1, 1, 'contato@empresa.com', 'pj', '11222333000181')`,
    );
    await run(
      `INSERT INTO users (id, name, username, password_hash, role, active, company_id, email)
       VALUES (4, 'Legado', 'legado', 'h', 'operacional', 1, 1, NULL)`,
    );
    await run(
      `INSERT INTO users (id, name, username, password_hash, role, active, company_id, email)
       VALUES (5, 'Numerico', '12345678901', 'h', 'operacional', 1, 1, 'num@x.com')`,
    );
  });

  it("acha PF por CPF, PJ por CNPJ e ambos por e-mail", async () => {
    assert.equal((await localizarConta("529.982.247-25"))?.id, 2, "CPF com máscara");
    assert.equal((await localizarConta("52998224725"))?.id, 2, "CPF cru");
    assert.equal((await localizarConta("11.222.333/0001-81"))?.id, 3, "CNPJ com máscara");
    assert.equal((await localizarConta("maria@pf.com"))?.id, 2, "e-mail minúsculo");
    assert.equal((await localizarConta("  MARIA@PF.COM  "))?.id, 2, "e-mail com caixa/espacos");
    assert.equal((await localizarConta("CONTATO@empresa.com"))?.id, 3, "e-mail de PJ");
  });

  it("mantém compatibilidade com contas antigas: usuário legado e username numérico", async () => {
    assert.equal((await localizarConta("legado"))?.id, 4, "username legado continua valendo");
    assert.equal((await localizarConta("LEGADO"))?.id, 4, "case-insensitive");
    assert.equal((await localizarConta("joao"))?.id, 1, "legado com e-mail acha pelo username");
    // Username de exatamente 11 dígitos: o documento não achou, cai no username.
    assert.equal((await localizarConta("12345678901"))?.id, 5);
  });

  it("identificador inexistente devolve null (nunca conta alheia)", async () => {
    assert.equal(await localizarConta("nao-existe"), null);
    assert.equal(await localizarConta("99999999999"), null, "CPF inexistente");
    assert.equal(await localizarConta("99.999.999/0000-99"), null, "CNPJ inexistente");
    assert.equal(await localizarConta("ghost@x.com"), null);
    assert.equal(await localizarConta(""), null);
    assert.equal(await localizarConta(null), null);
  });

  it("e-mail legado DUPLICADO é ambíguo: nenhuma conta é escolhida", async () => {
    await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa 2', 1)`);
    await run(
      `INSERT INTO users (id, name, username, password_hash, role, active, company_id, email)
       VALUES (6, 'Clone', 'clone', 'h', 'operacional', 1, 2, 'joao@x.com')`,
    );
    assert.equal(await localizarConta("joao@x.com"), null, "2 contas = sem login por e-mail");
    // O username continua inequívoco para as duas.
    assert.equal((await localizarConta("joao"))?.id, 1);
    assert.equal((await localizarConta("clone"))?.id, 6);
  });
});

/* --------------------------- unicidade --------------------------- */

describe("unicidade de documento e e-mail", async () => {
  const { documentoJaUsado, emailJaUsado } = await import("../src/lib/contas.ts");

  it("checagem de aplicação detecta documento/e-mail já usados (fora da própria conta)", async () => {
    await run(`UPDATE users SET person_type = 'pf', document = '11144477735' WHERE id = 1`);
    assert.ok(await documentoJaUsado("111.444.777-35"));
    assert.ok(!(await documentoJaUsado("11144477735", 1)), "a própria conta não conta como duplicata");
    assert.ok(!(await documentoJaUsado("52998224725")));

    assert.ok(await emailJaUsado("joao@x.com"));
    assert.ok(!(await emailJaUsado("joao@x.com", 1)));
    assert.ok(!(await emailJaUsado("novo@x.com")));
    assert.ok(!(await emailJaUsado("")), "e-mail vazio nunca é duplicata");
  });

  it("índice ÚNICO do banco barra corrida de cadastros simultâneos", async () => {
    await run(`UPDATE users SET person_type = 'pf', document = '11144477735' WHERE id = 1`);
    await assert.rejects(
      () =>
        run(
          `INSERT INTO users (id, name, username, password_hash, role, active, company_id, document)
           VALUES (9, 'Corrida', 'corrida', 'h', 'operacional', 1, 1, '11144477735')`,
        ),
      /UNIQUE/i,
      "segundo INSERT do mesmo documento estoura o índice parcial idx_users_document",
    );
    // E o CHECK de comprimento impede gravação fora do padrão CPF/CNPJ.
    await assert.rejects(
      () => run(`UPDATE users SET document = '123' WHERE id = 1`),
      /CHECK/i,
    );
  });
});

/* ------------------------ migração 0037 ------------------------ */

describe("migração 0037: não destrutiva e compatível com o legado", () => {
  it("conta legada sobrevive com person_type/document NULL após a migração", async () => {
    // Banco "antigo": todas as migrations EXCETO a 0037.
    const db = new FakeD1();
    const dir = path.join(ROOT, "migrations");
    const arquivos = fs.readdirSync(dir).sort().filter((f) => f.endsWith(".sql"));
    for (const f of arquivos) {
      if (f.startsWith("0037_")) continue;
      db.sqlite.exec(fs.readFileSync(path.join(dir, f), "utf8"));
    }
    // Conta legada sem documento/e-mail — dados históricos reais não tinham.
    db.sqlite.exec(
      `INSERT INTO users (id, name, username, email, password_hash, role, active, company_id)
       VALUES (7, 'Antiga', 'antiga', 'antiga@x.com', 'hash-velho', 'owner', 1, 1)`,
    );
    // Migração nova por cima: só adiciona colunas/índices.
    db.sqlite.exec(fs.readFileSync(path.join(dir, "0037_cadastro_identidade.sql"), "utf8"));

    const linha = db.sqlite.prepare(`SELECT * FROM users WHERE id = 7`).get() as any;
    assert.ok(linha, "nenhuma conta foi apagada");
    assert.equal(linha.username, "antiga");
    assert.equal(linha.email, "antiga@x.com");
    assert.equal(linha.password_hash, "hash-velho");
    assert.equal(linha.person_type, null, "tipo de pessoa NÃO é suposto pela migração");
    assert.equal(linha.document, null, "documento NÃO é suposto pela migração");
    // Login legado por username continua funcionando (índices só de apoio).
    const porUsername = db.sqlite.prepare(`SELECT id FROM users WHERE lower(username) = 'antiga'`).get() as any;
    assert.equal(porUsername.id, 7);
    // Migração aplicável em base legada sem perder nada (colunas novas NULL).
    const nulos = db.sqlite.prepare(`SELECT COUNT(*) AS n FROM users WHERE document IS NULL`).get() as any;
    assert.equal(nulos.n, 1);
  });
});

/* ------------- backend é a barreira (interface ignorada) ------------- */

let seqInt = 0;

describe("criarUsuario: validação no backend mesmo sem interface", async () => {
  const { criarUsuario, atualizarUsuario } = await import("../src/lib/usuarios.ts");

  async function admin() {
    const id = await insert(
      `INSERT INTO users (name, username, password_hash, role, company_id) VALUES ('Admin', 'adm', 'h', 'owner', 1)`,
    );
    return { id, name: "Admin", company_id: 1, role: "owner" as const };
  }

  const completo = {
    name: "Novo",
    username: "novo",
    password: "senha123",
    role: "operacional",
    email: "novo@x.com",
    tipo_pessoa: "pf",
    documento: "52998224725",
  };

  it("cadastro PF completo passa e persiste tipo/documento normalizados", async () => {
    const adm = await admin();
    const r = await criarUsuario(adm, { ...completo, documento: "529.982.247-25", email: " NOVO@X.COM " });
    assert.ok(r.ok, JSON.stringify(r));
    const row = await one<any>(`SELECT * FROM users WHERE id = ?`, [(r as any).id]);
    assert.equal(row.person_type, "pf");
    assert.equal(row.document, "52998224725");
    assert.equal(row.email, "novo@x.com", "e-mail normalizado");
  });

  it("recusa tipo ausente, documento ausente/inválido, e-mail ausente/inválido", async () => {
    const adm = await admin();
    const semTipo = await criarUsuario(adm, { ...completo, tipo_pessoa: "" });
    assert.ok(!semTipo.ok && /tipo de pessoa/i.test((semTipo as any).erro));

    const semDoc = await criarUsuario(adm, { ...completo, documento: "" });
    assert.ok(!semDoc.ok && /CPF/i.test((semDoc as any).erro));

    const docInvalido = await criarUsuario(adm, { ...completo, documento: "11111111111" });
    assert.ok(!docInvalido.ok && /CPF inválido/i.test((docInvalido as any).erro));

    const cnpjEmPf = await criarUsuario(adm, { ...completo, documento: "11222333000181" });
    assert.ok(!cnpjEmPf.ok && /CPF/i.test((cnpjEmPf as any).erro));

    const semEmail = await criarUsuario(adm, { ...completo, email: "" });
    assert.ok(!semEmail.ok && /e-mail/i.test((semEmail as any).erro));

    const emailInvalido = await criarUsuario(adm, { ...completo, email: "x@y" });
    assert.ok(!emailInvalido.ok && /E-mail inválido/i.test((emailInvalido as any).erro));

    assert.equal(await scalar(`SELECT COUNT(*) FROM users`), 2, "só o admin legado: nada foi gravado");
  });

  it("recusa documento e e-mail duplicados (inclusive de outra empresa)", async () => {
    const adm = await admin();
    const r1 = await criarUsuario(adm, completo);
    assert.ok(r1.ok);

    const docDup = await criarUsuario(adm, { ...completo, username: "outro1", email: "outro1@x.com" });
    assert.ok(!docDup.ok && /CPF\/CNPJ já está cadastrado/i.test((docDup as any).erro));

    const emailDup = await criarUsuario(adm, {
      ...completo,
      username: "outro2",
      email: "NOVO@x.com",
      documento: "11144477735",
    });
    assert.ok(!emailDup.ok && /e-mail já está cadastrado/i.test((emailDup as any).erro));
  });

  it("usuário INTERNO nasce sem PF/PJ (documento é exigência só do contratante)", async () => {
    const adm = await admin();
    const r = await criarUsuario(adm, {
      name: "Operadora",
      username: `int${++seqInt}`,
      password: "senha123",
      role: "operacional",
      email: `int${seqInt}@x.com`,
      // sem tipo_pessoa e sem documento — o formulário interno não envia
    });
    assert.ok(r.ok, JSON.stringify(r));
    const row = await one<any>(`SELECT person_type, document FROM users WHERE id = ?`, [(r as any).id]);
    assert.equal(row.person_type, null, "tipo de pessoa não é suposto para usuário interno");
    assert.equal(row.document, null, "documento não é suposto para usuário interno");
  });

  it("documento sem tipo (payload manipulado) continua recusado", async () => {
    const adm = await admin();
    const r = await criarUsuario(adm, {
      ...completo,
      username: `payload${++seqInt}`,
      email: `payload${seqInt}@x.com`,
      tipo_pessoa: "",
      documento: "52998224725",
    });
    assert.ok(!r.ok && /tipo de pessoa/i.test((r as { erro: string }).erro));
  });

  it("PJ: criação aceita CNPJ e persiste o tipo", async () => {
    const adm = await admin();
    const r = await criarUsuario(adm, {
      ...completo,
      tipo_pessoa: "PJ",
      documento: "11.222.333/0001-81",
      email: "pj@x.com",
    });
    assert.ok(r.ok, JSON.stringify(r));
    const row = await one<any>(`SELECT person_type, document FROM users WHERE id = ?`, [(r as any).id]);
    assert.equal(row.person_type, "pj");
    assert.equal(row.document, "11222333000181");
  });

  it("edição NÃO altera tipo de pessoa/documento (imutáveis fora do fluxo próprio)", async () => {
    const adm = await admin();
    const r = await criarUsuario(adm, completo);
    assert.ok(r.ok);
    const id = (r as any).id;

    // Payload manipulado tentando trocar a identidade: o campo nem é aceito.
    await atualizarUsuario(adm, id, {
      name: "Novo Nome",
      username: "novo",
      role: "operacional",
      email: "novo@x.com",
      tipo_pessoa: "pj",
      documento: "11222333000181",
    } as any);
    const row = await one<any>(`SELECT name, person_type, document FROM users WHERE id = ?`, [id]);
    assert.equal(row.name, "Novo Nome", "nome edita normalmente");
    assert.equal(row.person_type, "pf", "tipo de pessoa NÃO mudou");
    assert.equal(row.document, "52998224725", "documento NÃO mudou");

    // E-mail inválido na edição: recusado.
    const r2 = await atualizarUsuario(adm, id, { name: "X", username: "novo", role: "operacional", email: "x@y" });
    assert.ok(!r2.ok && /E-mail inválido/i.test((r2 as any).erro));
    // E-mail de outra conta: recusado.
    await run(`UPDATE users SET email = 'ocupado@x.com' WHERE id = 1`);
    const r3 = await atualizarUsuario(adm, id, {
      name: "X",
      username: "novo",
      role: "operacional",
      email: "ocupado@x.com",
    });
    assert.ok(!r3.ok && /e-mail já está cadastrado/i.test((r3 as any).erro));
  });

  it("complemento cadastral de legado: preenche só o que falta (via SQL do fluxo)", async () => {
    // Simula a ação completarCadastro: usuário legado sem tipo/documento.
    const row = await one<any>(`SELECT person_type, document, email FROM users WHERE id = 1`);
    assert.equal(row.person_type, null);
    assert.equal(row.document, null);
    // Mesmo SQL da action (COALESCE nunca sobrescreve o que já existe).
    await run(
      `UPDATE users SET person_type = COALESCE(person_type, ?),
                        document    = COALESCE(document, ?),
                        email       = COALESCE(NULLIF(email, ''), ?)
        WHERE id = ?`,
      ["pf", "12345678909", "nunca@usado.com", 1],
    );
    const depois = await one<any>(`SELECT person_type, document, email FROM users WHERE id = 1`);
    assert.equal(depois.person_type, "pf");
    assert.equal(depois.document, "12345678909");
    assert.equal(depois.email, "Joao@X.com", "e-mail existente não é substituído");

    // Rodar de novo com outro documento não troca o já gravado.
    await run(
      `UPDATE users SET person_type = COALESCE(person_type, ?), document = COALESCE(document, ?) WHERE id = ?`,
      ["pj", "11222333000181", 1],
    );
    const final = await one<any>(`SELECT person_type, document FROM users WHERE id = 1`);
    assert.equal(final.person_type, "pf");
    assert.equal(final.document, "12345678909");
  });
});
