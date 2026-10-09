/**
 * Recuperação de senha (Etapa 5): pedido idempotente, token de uso único com
 * hash SHA-256, expiração, invalidação das sessões antigas e limpeza.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { one, resetCompanyCache, run } from "../src/lib/db.ts";
import { __definirEmailTeste, __emailsEnviados } from "../src/lib/email.ts";

function diaBRISO(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

beforeEach(async () => {
  createTestDb();
  resetCompanyCache();
  __definirEmailTeste(null);
  await run(`DELETE FROM password_resets`);
  await run(`DELETE FROM companies`);
  await run(`DELETE FROM users`);
  await run(`INSERT INTO companies (id, name, active) VALUES (1, 'Empresa', 1)`);
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, active, company_id, email)
     VALUES (1, 'João', 'joao', 'hash-antigo', 'owner', 1, 1, 'joao@x.com')`,
  );
});

async function tokenDoBanco(): Promise<{ token_hash: string; expires_at: string }> {
  return (await one<any>(`SELECT token_hash, expires_at FROM password_resets WHERE user_id = 1`))!;
}

describe("pedirRedefinicao", () => {
  it("grava token com hash (nunca o token cru) e expiração de 1h", async () => {
    const { pedirRedefinicao } = await import("../src/lib/recuperacao.ts");
    __definirEmailTeste({
      apiKey: "k",
      from: "f@x.com",
      fetchImpl: (async () => new Response(JSON.stringify({ id: "e1" }), { status: 200 })) as any,
    });

    const r = await pedirRedefinicao({ identificador: "joao" });
    assert.ok(r.ok);
    const linha = await tokenDoBanco();
    assert.ok(linha.token_hash.length === 64, "SHA-256 hex no banco");
    const delta = Date.parse(linha.expires_at) - Date.now();
    assert.ok(delta > 55 * 60 * 1000 && delta <= 60 * 60 * 1000, "expira em ~1h");

    // E-mail disparado com o link (nunca com o hash).
    assert.equal(__emailsEnviados.length, 1);
    assert.match(__emailsEnviados[0].html, /redefinir-senha\?token=/);
    assert.ok(!__emailsEnviados[0].html.includes(linha.token_hash));
  });

  it("resposta idêntica para usuário inexistente (sem dicionário de contas)", async () => {
    const { pedirRedefinicao } = await import("../src/lib/recuperacao.ts");
    const r = await pedirRedefinicao({ identificador: "nao-existe" });
    assert.ok(r.ok, "mesmo resultado de sucesso");
    const n = await one<any>(`SELECT COUNT(*) AS n FROM password_resets`);
    assert.equal(n.n, 0, "nada gravado para usuário fantasma");
  });

  it("novo pedido substitui o anterior (um token ativo por usuário)", async () => {
    const { pedirRedefinicao } = await import("../src/lib/recuperacao.ts");
    __definirEmailTeste({
      apiKey: "k",
      from: "f@x.com",
      fetchImpl: (async () => new Response("{}", { status: 200 })) as any,
    });
    await pedirRedefinicao({ identificador: "joao" });
    await pedirRedefinicao({ identificador: "JOAO" }); // case-insensitive
    const linhas = await one<any>(`SELECT COUNT(*) AS n FROM password_resets`);
    assert.equal(linhas.n, 1, "token antigo invalidado");
  });
});

describe("aplicarRedefinicao", () => {
  it("define a senha nova, encerra sessões e consome o token (uso único)", async () => {
    const rec = await import("../src/lib/recuperacao.ts");
    __definirEmailTeste({
      apiKey: "k",
      from: "f@x.com",
      fetchImpl: (async () => new Response("{}", { status: 200 })) as any,
    });

    // Captura o token cru: pedido via módulo grava só o hash, então simulamos
    // o fluxo real calculando o hash do token que o teste "recebeu por e-mail".
    await run(`DELETE FROM password_resets`);
    const { createHash, randomBytes } = await import("node:crypto");
    const tokenCru = randomBytes(32).toString("hex");
    await run(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (1, ?, ?)`, [
      createHash("sha256").update(tokenCru).digest("hex"),
      diaBRISO(60 * 60 * 1000),
    ]);
    await run(`INSERT INTO sessions (id, user_id, expires_at) VALUES ('sessao-antiga', 1, ?)`, [
      diaBRISO(86400000),
    ]);

    const r = await rec.aplicarRedefinicao({ token: tokenCru, senha: "senha-nova-forte" });
    assert.ok(r.ok);

    const user = await one<any>(`SELECT password_hash FROM users WHERE id = 1`);
    assert.notEqual(user.password_hash, "hash-antigo");
    assert.match(user.password_hash, /^scrypt\$/);
    const { verifyPassword } = await import("../src/lib/password.ts");
    assert.ok(verifyPassword("senha-nova-forte", user.password_hash));

    const sessoes = await one<any>(`SELECT COUNT(*) AS n FROM sessions WHERE user_id = 1`);
    assert.equal(sessoes.n, 0, "sessões antigas encerradas");
    const token = await tokenDoBanco();
    assert.ok(token, "registro permanece para auditoria");
    const used = await one<any>(`SELECT used_at FROM password_resets WHERE user_id = 1`);
    assert.ok(used.used_at, "token marcado como usado");
  });

  it("recusa token reutilizado, expirado, inexistente e senha curta", async () => {
    const rec = await import("../src/lib/recuperacao.ts");
    const { createHash, randomBytes } = await import("node:crypto");
    const tokenCru = randomBytes(32).toString("hex");
    await run(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (1, ?, ?)`, [
      createHash("sha256").update(tokenCru).digest("hex"),
      diaBRISO(3600000),
    ]);
    assert.ok((await rec.aplicarRedefinicao({ token: tokenCru, senha: "senha-forte-123" })).ok);

    const r2 = await rec.aplicarRedefinicao({ token: tokenCru, senha: "senha-forte-123" });
    assert.ok(!r2.ok, "uso único");

    await run(`DELETE FROM password_resets`);
    await run(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (1, ?, ?)`, [
      createHash("sha256").update("outro").digest("hex"),
      diaBRISO(-60000), // já expirado
    ]);
    const r3 = await rec.aplicarRedefinicao({ token: "outro", senha: "senha-forte-123" });
    assert.ok(!r3.ok && /expirado/i.test((r3 as any).erro));

    const r4 = await rec.aplicarRedefinicao({ token: "fantasma", senha: "senha-forte-123" });
    assert.ok(!r4.ok);
    const r5 = await rec.aplicarRedefinicao({ token: "outro2", senha: "curta" });
    assert.ok(!r5.ok);
  });
});

describe("pedirRedefinicao por identificador (CPF/CNPJ/e-mail)", () => {
  const cfgEmail = {
    apiKey: "k",
    from: "f@x.com",
    fetchImpl: (async () => new Response("{}", { status: 200 })) as any,
  };

  beforeEach(async () => {
    // Segundo usuário: dono PJ com CNPJ + conta legada sem e-mail.
    await run(
      `INSERT INTO users (id, name, username, password_hash, role, active, company_id, email, person_type, document)
       VALUES (2, 'Empresa Zero', 'juridica', 'hash', 'owner', 1, 1, 'contato@zero.com', 'pj', '11222333000181')`,
    );
    await run(
      `INSERT INTO users (id, name, username, password_hash, role, active, company_id, email, person_type, document)
       VALUES (3, 'Sem Email', 'legado', 'hash', 'operacional', 1, 1, NULL, 'pf', '11144477735')`,
    );
    __definirEmailTeste(cfgEmail);
  });

  it("localiza por CPF, CNPJ e e-mail — e envia para o e-mail CADASTRADO", async () => {
    const { pedirRedefinicao } = await import("../src/lib/recuperacao.ts");

    // CPF do usuário 1 (persona física, e-mail joao@x.com).
    await run(`UPDATE users SET person_type = 'pf', document = '52998224725' WHERE id = 1`);
    await pedirRedefinicao({ identificador: "529.982.247-25" });
    assert.equal(__emailsEnviados.at(-1)?.to, "joao@x.com", "CPF achou a conta e enviou ao e-mail dela");

    // CNPJ da conta 2.
    await pedirRedefinicao({ identificador: "11.222.333/0001-81" });
    assert.equal(__emailsEnviados.at(-1)?.to, "contato@zero.com");

    // E-mail direto (PF ou PJ).
    await pedirRedefinicao({ identificador: "JOAO@X.COM" });
    assert.equal(__emailsEnviados.at(-1)?.to, "joao@x.com");

    // Um token ativo por conta: CPF e e-mail do usuário 1 compartilham o
    // mesmo pedido (o último substitui o anterior) — 2 contas = 2 linhas.
    const n = await one<any>(`SELECT COUNT(*) AS n FROM password_resets`);
    assert.equal(n.n, 2);
  });

  it("documento inválido/desconhecido e conta sem e-mail: resposta ok e NADA enviado", async () => {
    const { pedirRedefinicao } = await import("../src/lib/recuperacao.ts");
    const antes = __emailsEnviados.length;

    const r1 = await pedirRedefinicao({ identificador: "111.111.111-11" }); // CPF inválido
    const r2 = await pedirRedefinicao({ identificador: "99999999999999" }); // CNPJ desconhecido
    const r3 = await pedirRedefinicao({ identificador: "nao@existe.com" });
    const r4 = await pedirRedefinicao({ identificador: "" });
    assert.ok(r1.ok && r2.ok && r3.ok && r4.ok, "resposta sempre idêntica");
    assert.equal(__emailsEnviados.length, antes, "nenhum e-mail disparado");
    const n = await one<any>(`SELECT COUNT(*) AS n FROM password_resets`);
    assert.equal(n.n, 0, "nenhum token gravado");

    // Conta existe e é ATIVA, mas não tem e-mail: não há canal seguro — nada a enviar.
    const r5 = await pedirRedefinicao({ identificador: "111.444.777-35" });
    assert.ok(r5.ok);
    assert.equal(__emailsEnviados.length, antes, "conta sem e-mail não recebe link");
  });

  it("conta INATIVA não recebe link", async () => {
    const { pedirRedefinicao } = await import("../src/lib/recuperacao.ts");
    const antes = __emailsEnviados.length;
    await run(`UPDATE users SET active = 0 WHERE id = 2`);
    const r = await pedirRedefinicao({ identificador: "11.222.333/0001-81" });
    assert.ok(r.ok);
    assert.equal(__emailsEnviados.length, antes);
  });
});

describe("limparTokensExpirados", () => {
  it("remove só os vencidos", async () => {
    const { limparTokensExpirados } = await import("../src/lib/recuperacao.ts");
    await run(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (1, 'a', ?)`, [
      diaBRISO(-3600000),
    ]);
    await run(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (1, 'b', ?)`, [
      diaBRISO(3600000),
    ]);
    const n = await limparTokensExpirados();
    assert.equal(n, 1);
    const restantes = await one<any>(`SELECT COUNT(*) AS n FROM password_resets`);
    assert.equal(restantes.n, 1);
  });
});
