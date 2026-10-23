/**
 * Transferência entre contas e Contas financeiras no SaaS MULTI-TENANT.
 *
 * Port fiel dos testes da origem (Lima's tests/transferencias.test.ts) com as
 * camadas que só existem no SaaS:
 *   * ISOLAMENTO ENTRE EMPRESAS: lib e actions reais com duas empresas no
 *     banco — conta/transferência de outro tenant é inexistente, IDOR por id
 *     e por grupo não contorna a autorização;
 *   * IDEMPOTÊNCIA: reenvio do mesmo formulário não duplica lançamento
 *     (índice único 0049 + token por form);
 *   * PERMISSÕES: matriz de papéis real (financeiro transfere; operacional não;
 *     excluir é admin/owner);
 *   * GUARDAS: deletePayment/estornarRecebimento não alcançam lados de
 *     transferência;
 *   * COMPATIBILIDADE: grupos legados migrados da Lima's continuam listáveis,
 *     editáveis e excluíveis.
 *
 * Banco SQLite real com as MIGRATIONS REAIS (tests/helpers/d1.ts) e scaffold
 * mínimo de next/* para importar as actions fora do runtime do Next.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/* ------------------------------------------------------------------ */
/* Scaffold do Next: as actions importam next/*, que exige o runtime.  */
/* ------------------------------------------------------------------ */

const SESSAO_UM = "sess-tf-owner-um"; // owner, empresa 1
const SESSAO_FIN = "sess-tf-fin-um"; // papel financeiro, empresa 1
const SESSAO_OPE = "sess-tf-oper-um"; // operacional, empresa 1
const SESSAO_DOIS = "sess-tf-owner-dois"; // owner, empresa 2
let sessaoAtual = SESSAO_UM;

const carregarOriginal = (Module as any)._load;

(Module as any)._load = function (request: string) {
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: (nome: string) => (nome === "limas_session" ? { value: sessaoAtual } : undefined),
        set: () => {},
        delete: () => {},
      }),
      headers: async () => new Map(),
    };
  }
  if (request === "next/navigation") {
    return {
      redirect: (url: string) => {
        throw new Error("NEXT_REDIRECT:" + url);
      },
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
      useRouter: () => ({ push() {}, replace() {}, prefetch() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "next/cache") {
    return { revalidatePath: () => {}, revalidateTag: () => {} };
  }
  if (request === "next/link" || request === "next/form" || request === "next/image") {
    const fake: any = (p: any) => p?.children ?? null;
    return { __esModule: true, default: fake, Link: fake };
  }
  if (request === "server-only") return {};
  return carregarOriginal.apply(this, arguments as any);
};

const carregar = (rel: string) => import(pathToFileURL(path.resolve(rel)).href);

/**
 * db.ts carregado com caminho LITERAL: só assim o TS conhece as assinaturas.
 * Um import com variável volta `any` e reprovava toda chamada com argumento
 * de tipo (`one<any>(...)` → TS2347).
 */
async function dbm() {
  return await import("../src/lib/db.ts");
}

/** URLSearchParams grava espaço como '+': decodificar precisa normalizar. */
const texto = (url: string): string => decodeURIComponent(url).replace(/\+/g, " ");

/* ------------------------------------------------------------------ */
/* Cenário: 2 empresas, 3 contas na empresa 1, 1 conta na empresa 2   */
/* ------------------------------------------------------------------ */

const FUTURO = new Date(Date.now() + 864e5).toISOString();

async function montarCenario() {
  const { run } = await dbm();
  await run(`UPDATE companies SET name = 'Empresa Um' WHERE id = 1`);
  await run(`INSERT INTO companies (id, name, active) VALUES (2, 'Empresa Dois', 1)`);
  await run(`INSERT OR IGNORE INTO stock_revision (id, revision) VALUES (1, 0), (2, 0)`);
  await run(
    `INSERT INTO subscriptions (company_id, plan_id, status, current_period_end)
     VALUES (1, (SELECT id FROM plans WHERE slug = 'empresarial'), 'active', ?),
            (2, (SELECT id FROM plans WHERE slug = 'empresarial'), 'active', ?)`,
    [FUTURO.slice(0, 10), FUTURO.slice(0, 10)],
  );
  await run(
    `INSERT INTO users (id, name, username, password_hash, role, company_id, active) VALUES
      (10, 'Dono Um', 'tf-dono-um', 'x', 'owner', 1, 1),
      (11, 'Fin Um', 'tf-fin-um', 'x', 'financeiro', 1, 1),
      (12, 'Oper Um', 'tf-oper-um', 'x', 'operacional', 1, 1),
      (20, 'Dono Dois', 'tf-dono-dois', 'x', 'owner', 2, 1)`,
  );
  await run(`INSERT INTO sessions (id, user_id, expires_at) VALUES
      (?, 10, ?), (?, 11, ?), (?, 12, ?), (?, 20, ?)`, [
    SESSAO_UM, FUTURO, SESSAO_FIN, FUTURO, SESSAO_OPE, FUTURO, SESSAO_DOIS, FUTURO,
  ]);
  await run(`INSERT INTO customers (id, name, phone, company_id) VALUES (100, 'Cliente Um', '31999990000', 1)`);
}

async function novaConta(
  nome: string,
  opts: { empresa?: number; inicial?: number; cash?: boolean } = {},
): Promise<number> {
  const { insert } = await dbm();
  return await insert(
    `INSERT INTO financial_accounts (name, kind, initial_balance_cents, is_cash_account, company_id) VALUES (?,?,?,?,?)`,
    [nome, opts.cash ? "dinheiro" : "banco", opts.inicial ?? 0, opts.cash ? 1 : 0, opts.empresa ?? 1],
  );
}

/** A MESMA conta da aplicação: inicial + entradas - saídas (Configurações). */
async function saldo(contaId: number): Promise<number> {
  const { one } = await dbm();
  const a = await one<any>(
    `SELECT a.initial_balance_cents
           + COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.account_id = a.id),0)
           - COALESCE((SELECT SUM(e.amount_cents) FROM expenses e WHERE e.account_id = a.id),0) AS saldo
       FROM financial_accounts a WHERE a.id = ?`,
    [contaId],
  );
  return Number(a.saldo);
}

type DadosTF = {
  origemId: number;
  destinoId: number;
  valorCents: number;
  data: string;
  observacao?: string;
  userId?: number;
  companyId?: number;
  grupo?: string;
};

let seqToken = 0;
async function criarOk(t: DadosTF) {
  const { criarTransferencia, } = await carregar("src/lib/transferencias.ts");
  const { novoGrupoTransferencia } = await carregar("src/lib/financeiro.ts");
  const r = await criarTransferencia({
    origemId: t.origemId,
    destinoId: t.destinoId,
    valorCents: t.valorCents,
    data: t.data,
    observacao: t.observacao,
    userId: t.userId ?? 10,
    companyId: t.companyId ?? 1,
    grupo: t.grupo ?? novoGrupoTransferencia(t.companyId ?? 1),
  });
  assert.ok(!("erro" in r), `transferência deveria ser aceita: ${"erro" in r ? r.erro : ""}`);
  return r as { id: number; grupo: string; duplicado?: true };
}

/** Chama uma action esperando o redirect de feedback (padrão do SaaS). */
async function redirecionado(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e: any) {
    if (String(e?.message ?? "").startsWith("NEXT_REDIRECT:")) {
      return String(e.message).slice("NEXT_REDIRECT:".length);
    }
    throw e;
  }
  throw new Error("esperava redirect da action, mas ela terminou em silêncio");
}

/** A action recusou por PERMISSÃO de papel (PermissionError)? */
async function lancouPermissao(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e: any) {
    return e?.name === "PermissionError";
  }
}

function fd(campos: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(campos)) f.set(k, v);
  return f;
}

async function contar(sql: string, params: any[] = []): Promise<number> {
  const { scalar } = await dbm();
  return Number((await scalar<number>(sql, params)) ?? 0);
}

async function cenario() {
  const { createTestDb, resetTestDb } = await carregar("tests/helpers/d1.ts");
  const db = await dbm();
  resetTestDb();
  db.resetCompanyCache();
  createTestDb();
  await montarCenario();
  sessaoAtual = SESSAO_UM;
}

/* ------------------------------------------------------------------ */
/* 1. Regras puras (validação)                                         */
/* ------------------------------------------------------------------ */

describe("validação da transferência (regras puras)", () => {
  beforeEach(cenario);

  it("recusa transferir para a própria conta", async () => {
    const { validarTransferencia } = await carregar("src/lib/financeiro.ts");
    assert.equal(validarTransferencia(7, 7, 10000, "2026-09-20"), "Origem e destino não podem ser a mesma conta.");
  });

  it("recusa valor zero, negativo, sem contas e data inválida", async () => {
    const { validarTransferencia } = await carregar("src/lib/financeiro.ts");
    assert.ok(validarTransferencia(1, 2, 0, "2026-09-20"));
    assert.ok(validarTransferencia(1, 2, -100, "2026-09-20"));
    assert.ok(validarTransferencia(0, 2, 100, "2026-09-20"));
    assert.ok(validarTransferencia(1, 0, 100, "2026-09-20"));
    assert.ok(validarTransferencia(1, 2, 100, "20/09/2026"));
    assert.equal(validarTransferencia(1, 2, 50000, "2026-09-20"), null);
  });

  it("o predicado SQL dos indicadores permanece o contrato compartilhado", async () => {
    const { SQL_NAO_TRANSFERENCIA } = await carregar("src/lib/financeiro.ts");
    assert.equal(SQL_NAO_TRANSFERENCIA, "transfer_group IS NULL");
  });
});

/* ------------------------------------------------------------------ */
/* 2. Criação: evento duplo, saldos, precisão                          */
/* ------------------------------------------------------------------ */

describe("criar transferência — evento duplo e saldos", () => {
  beforeEach(cenario);

  it("banco → banco: débito na origem, crédito no destino, um único evento", async () => {
    const { one } = await dbm();
    const origem = await novaConta("Bradesco PJ", { inicial: 100000 });
    const destino = await novaConta("Itaú", { inicial: 20000 });
    const r = await criarOk({ origemId: origem, destinoId: destino, valorCents: 50000, data: "2026-09-20" });

    const saida = await one<any>(`SELECT * FROM payments WHERE transfer_group = ? AND amount_cents < 0`, [r.grupo]);
    const entrada = await one<any>(`SELECT * FROM payments WHERE transfer_group = ? AND amount_cents >= 0`, [r.grupo]);
    assert.equal(saida.amount_cents, -50000);
    assert.equal(saida.account_id, origem);
    assert.equal(entrada.amount_cents, 50000);
    assert.equal(entrada.account_id, destino);
    assert.equal(saida.paid_at, "2026-09-20");
    assert.equal(saida.transfer_group, entrada.transfer_group, "mesmo grupo = único evento lógico");
    assert.equal(saida.transfer_counterpart_id, entrada.id);
    assert.equal(entrada.transfer_counterpart_id, saida.id);
    assert.equal(saida.notes, "Transferência para Itaú");
    assert.equal(entrada.notes, "Transferência recebida de Bradesco PJ");
    assert.equal(saida.method, "transferencia");
    assert.equal(saida.reservation_id ?? null, null);
    assert.equal(saida.entry_id ?? null, null);
    assert.equal(saida.freight_id ?? null, null);
    assert.equal(saida.company_id, 1, "ambos os lados gravam a empresa da sessão");
    assert.equal(entrada.company_id, 1);
    assert.equal(saida.created_by, 10);
  });

  it("banco → dinheiro em espécie (R$ 500) e volta (R$ 200)", async () => {
    const bradesco = await novaConta("Bradesco PJ", { inicial: 100000 });
    const carteira = await novaConta("Carteira Física", { cash: true, inicial: 0 });
    await criarOk({ origemId: bradesco, destinoId: carteira, valorCents: 50000, data: "2026-09-20" });
    assert.equal(await saldo(carteira), 50000);
    assert.equal(await saldo(bradesco), 50000);

    await criarOk({ origemId: carteira, destinoId: bradesco, valorCents: 20000, data: "2026-09-21" });
    assert.equal(await saldo(carteira), 30000);
    assert.equal(await saldo(bradesco), 70000);
  });

  it("espécie → espécie funciona como qualquer outra conta", async () => {
    const carteira = await novaConta("Carteira", { cash: true, inicial: 50000 });
    const caixa = await novaConta("Caixa da Loja", { cash: true, inicial: 10000 });
    await criarOk({ origemId: carteira, destinoId: caixa, valorCents: 15000, data: "2026-09-21" });
    assert.equal(await saldo(carteira), 35000);
    assert.equal(await saldo(caixa), 25000);
  });

  it("recusa mesma conta / zero / negativo sem gravar nada", async () => {
    const { criarTransferencia } = await carregar("src/lib/transferencias.ts");
    const { novoGrupoTransferencia } = await carregar("src/lib/financeiro.ts");
    const a = await novaConta("A");
    const b = await novaConta("B");
    const base = { origemId: a, destinoId: b, valorCents: 10000, data: "2026-09-21", userId: 10, companyId: 1 };

    const mesma = await criarTransferencia({ ...base, destinoId: a, grupo: novoGrupoTransferencia(1) });
    const zero = await criarTransferencia({ ...base, valorCents: 0, grupo: novoGrupoTransferencia(1) });
    const negativo = await criarTransferencia({ ...base, valorCents: -5000, grupo: novoGrupoTransferencia(1) });
    assert.ok("erro" in mesma && /mesma conta/.test(mesma.erro));
    assert.ok("erro" in zero);
    assert.ok("erro" in negativo);
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 0, "nada foi gravado");
  });

  it("saldo de ambas as contas reflete o valor; consolidado não muda", async () => {
    const origem = await novaConta("Origem", { inicial: 80000 });
    const destino = await novaConta("Destino", { inicial: 5000 });
    const antes = (await saldo(origem)) + (await saldo(destino));

    await criarOk({ origemId: origem, destinoId: destino, valorCents: 30000, data: "2026-09-21" });

    assert.equal(await saldo(origem), 50000);
    assert.equal(await saldo(destino), 35000);
    assert.equal((await saldo(origem)) + (await saldo(destino)), antes, "a transferência não criou nem destruiu dinheiro");
  });

  it("sem verificação de saldo (regra da referência): origem pode ficar negativa", async () => {
    const origem = await novaConta("Poupança", { inicial: 10000 });
    const destino = await novaConta("Destino");
    await criarOk({ origemId: origem, destinoId: destino, valorCents: 50000, data: "2026-09-21" });
    assert.equal(await saldo(origem), -40000, "o saldo negativo é visível (vermelho) em vez de operação recusada");
  });

  it("centavos: R$ 0,01 move exatamente 1 centavo nos dois lados", async () => {
    const { one } = await dbm();
    const a = await novaConta("A", { inicial: 100 });
    const b = await novaConta("B");
    const r = await criarOk({ origemId: a, destinoId: b, valorCents: 1, data: "2026-09-21" });
    const saida = await one<any>(`SELECT amount_cents FROM payments WHERE transfer_group = ? AND amount_cents < 0`, [r.grupo]);
    const entrada = await one<any>(`SELECT amount_cents FROM payments WHERE transfer_group = ? AND amount_cents >= 0`, [r.grupo]);
    assert.equal(saida.amount_cents, -1);
    assert.equal(entrada.amount_cents, 1);
    assert.equal(await saldo(a), 99);
    assert.equal(await saldo(b), 1);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Idempotência e duplicidade                                       */
/* ------------------------------------------------------------------ */

describe("idempotência — reenvio do formulário não duplica", () => {
  beforeEach(cenario);

  it("mesmo token duas vezes: segunda resposta é confirmação, sem lançamento novo", async () => {
    const { criarTransferencia } = await carregar("src/lib/transferencias.ts");
    const { novoGrupoTransferencia } = await carregar("src/lib/financeiro.ts");
    const a = await novaConta("A", { inicial: 100000 });
    const b = await novaConta("B");
    const grupo = novoGrupoTransferencia(1);
    const base = { origemId: a, destinoId: b, valorCents: 25000, data: "2026-09-21", userId: 10, companyId: 1, grupo };

    const primeira = await criarTransferencia(base);
    assert.ok(!("erro" in primeira) && !("duplicado" in primeira && primeira.duplicado));

    const segunda = await criarTransferencia(base);
    assert.ok(!("erro" in segunda), `reenvio não é erro: ${"erro" in segunda ? segunda.erro : ""}`);
    assert.ok("duplicado" in segunda && segunda.duplicado, "segundo envio é reconhecido como já realizado");

    assert.equal(await contar(`SELECT COUNT(*) FROM payments WHERE transfer_group = ?`, [grupo]), 2, "um evento = dois lados, nunca quatro");
    assert.equal(await saldo(a), 75000, "saldo debitado uma única vez");
    assert.equal(await saldo(b), 25000);
  });

  it("tokens diferentes criam eventos distintos (dois envios legítimos)", async () => {
    const a = await novaConta("A", { inicial: 100000 });
    const b = await novaConta("B");
    await criarOk({ origemId: a, destinoId: b, valorCents: 10000, data: "2026-09-21" });
    await criarOk({ origemId: a, destinoId: b, valorCents: 10000, data: "2026-09-21" });
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 4);
    assert.equal(await saldo(a), 80000);
  });

  it("o índice único 0049 recusa um segundo débito no mesmo grupo (prova do banco)", async () => {
    const a = await novaConta("A", { inicial: 100000 });
    const b = await novaConta("B");
    const r = await criarOk({ origemId: a, destinoId: b, valorCents: 10000, data: "2026-09-21" });
    const { run } = await dbm();
    await assert.rejects(
      () =>
        run(
          `INSERT INTO payments (reservation_id, freight_id, amount_cents, method, paid_at, account_id, company_id, transfer_group)
           VALUES (NULL,NULL,-999,'transferencia','2026-09-22',?,?,?)`,
          [a, 1, r.grupo],
        ),
      /UNIQUE/i,
      "sem o índice, o clique duplo gravaria o débito duas vezes",
    );
    assert.equal(await saldo(a), 90000);
  });

  it("token com o prefixo de OUTRA empresa é recusado antes de tocar em banco", async () => {
    const { criarTransferencia } = await carregar("src/lib/transferencias.ts");
    const { novoGrupoTransferencia } = await carregar("src/lib/financeiro.ts");
    const a = await novaConta("A", { inicial: 100000 });
    const b = await novaConta("B");
    const r = await criarTransferencia({
      origemId: a,
      destinoId: b,
      valorCents: 10000,
      data: "2026-09-21",
      userId: 10,
      companyId: 1,
      grupo: novoGrupoTransferencia(2), // token pertencente à empresa 2
    });
    assert.ok("erro" in r);
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 0);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Edição e exclusão                                                */
/* ------------------------------------------------------------------ */

describe("edição e exclusão — os dois lados sempre juntos", () => {
  beforeEach(cenario);

  it("edição atualiza valor, data, destino e observação dos dois lados", async () => {
    const { one } = await dbm();
    const { editarTransferencia } = await carregar("src/lib/transferencias.ts");
    const origem = await novaConta("Origem", { inicial: 100000 });
    const destino = await novaConta("Destino");
    const outra = await novaConta("Outra");
    const r = await criarOk({ origemId: origem, destinoId: destino, valorCents: 20000, data: "2026-09-20" });

    const e = await editarTransferencia(r.grupo, {
      origemId: origem,
      destinoId: outra,
      valorCents: 35000,
      data: "2026-09-22",
      observacao: "ajuste",
      userId: 10,
      companyId: 1,
      grupo: r.grupo,
    });
    assert.ok(!("erro" in e));

    const saida = await one<any>(`SELECT * FROM payments WHERE transfer_group = ? AND amount_cents < 0`, [r.grupo]);
    const entrada = await one<any>(`SELECT * FROM payments WHERE transfer_group = ? AND amount_cents >= 0`, [r.grupo]);
    assert.equal(saida.amount_cents, -35000);
    assert.equal(entrada.amount_cents, 35000);
    assert.equal(entrada.account_id, outra);
    assert.equal(saida.paid_at, "2026-09-22");
    assert.equal(saida.notes, "Transferência para Outra | ajuste");
    assert.equal(entrada.notes, "Transferência recebida de Origem | ajuste");
    assert.equal(await saldo(destino), 0, "destino antigo volta ao valor anterior na troca");
    assert.equal(await saldo(outra), 35000);
  });

  it("edição recusa origem = destino sem alterar lado nenhum", async () => {
    const { all } = await dbm();
    const { editarTransferencia } = await carregar("src/lib/transferencias.ts");
    const a = await novaConta("A");
    const b = await novaConta("B");
    const r = await criarOk({ origemId: a, destinoId: b, valorCents: 10000, data: "2026-09-20" });
    const antes = await all<any>(`SELECT * FROM payments WHERE transfer_group = ? ORDER BY id`, [r.grupo]);

    const e = await editarTransferencia(r.grupo, {
      origemId: a,
      destinoId: a,
      valorCents: 999,
      data: "2026-09-21",
      userId: 10,
      companyId: 1,
      grupo: r.grupo,
    });
    assert.ok("erro" in e);
    const depois = await all<any>(`SELECT * FROM payments WHERE transfer_group = ? ORDER BY id`, [r.grupo]);
    assert.deepEqual(depois, antes);
  });

  it("exclusão remove os dois lados e reverte os saldos", async () => {
    const { excluirTransferencia } = await carregar("src/lib/transferencias.ts");
    const origem = await novaConta("Origem", { inicial: 60000 });
    const destino = await novaConta("Destino");
    const r = await criarOk({ origemId: origem, destinoId: destino, valorCents: 25000, data: "2026-09-20" });
    assert.equal(await saldo(origem), 35000);

    const x = await excluirTransferencia(r.grupo, 1);
    assert.ok(!("erro" in x));
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 0, "os dois lados saíram juntos");
    assert.equal(await saldo(origem), 60000);
    assert.equal(await saldo(destino), 0);
  });

  it("listagem só mostra grupos completos", async () => {
    const { all, run } = await dbm();
    const { listarTransferencias } = await carregar("src/lib/transferencias.ts");
    const a = await novaConta("A");
    const b = await novaConta("B");
    const r1 = await criarOk({ origemId: a, destinoId: b, valorCents: 10000, data: "2026-09-20" });
    await criarOk({ origemId: b, destinoId: a, valorCents: 4000, data: "2026-09-21" });
    assert.equal((await listarTransferencias(1)).length, 2);

    // lado apagado isoladamente (ex.: admin direto no banco): o grupo fica
    // invisível até ser consertado — a tela não pode excluir "só o que vê"
    await run(`DELETE FROM payments WHERE transfer_group = ? AND amount_cents >= 0`, [r1.grupo]);
    const lista = await listarTransferencias(1);
    assert.equal(lista.length, 1);
    assert.equal(lista[0].valor_cents, 4000);
    assert.equal((await all<any>(`SELECT * FROM payments WHERE transfer_group = ?`, [r1.grupo])).length, 1);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Multiempresa na LIB                                              */
/* ------------------------------------------------------------------ */

describe("multiempresa — a transferência nunca atravessa tenants", () => {
  beforeEach(cenario);

  it("conta de outra empresa é 'não encontrada' e nada é gravado", async () => {
    const { criarTransferencia } = await carregar("src/lib/transferencias.ts");
    const minha = await novaConta("Minha", { inicial: 100000 });
    const alheia = await novaConta("Alheia", { empresa: 2, inicial: 999999 });
    const r = await criarTransferencia({
      origemId: minha,
      destinoId: alheia,
      valorCents: 50000,
      data: "2026-09-21",
      userId: 10,
      companyId: 1,
      grupo: `TF-1-${crypto.randomUUID()}`,
    });
    assert.ok("erro" in r);
    assert.match(r.erro, /não encontrada/);
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 0, "nenhum lado entrou em nenhuma empresa");
    assert.equal(await saldo(alheia), 999999, "conta da outra empresa intocada");
  });

  it("listarTransferencias devolve só as transferências da própria empresa", async () => {
    const { criarTransferencia, listarTransferencias } = await carregar("src/lib/transferencias.ts");
    const { novoGrupoTransferencia } = await carregar("src/lib/financeiro.ts");
    const minha = await novaConta("Minha");
    const alheia = await novaConta("Alheia", { empresa: 2 });
    const cruzada = await criarTransferencia({
      origemId: minha, destinoId: alheia, valorCents: 1, data: "2026-09-21", userId: 10, companyId: 1,
      grupo: novoGrupoTransferencia(1),
    });
    assert.ok("erro" in cruzada, "transferência cross-tenant é recusada");
    const a1 = await novaConta("A1");
    const a2 = await novaConta("A2");
    const b1 = await novaConta("B1", { empresa: 2 });
    await criarOk({ origemId: a1, destinoId: a2, valorCents: 10000, data: "2026-09-20", companyId: 1 });
    const b2 = await novaConta("B2", { empresa: 2 });
    await criarOk({ origemId: b1, destinoId: b2, valorCents: 7000, data: "2026-09-19", companyId: 2 });

    const lista1 = await listarTransferencias(1);
    const lista2 = await listarTransferencias(2);
    assert.equal(lista1.length, 1);
    assert.equal(lista1[0].origem_nome, "A1");
    assert.equal(lista2.length, 1);
    assert.equal(lista2[0].origem_nome, "B1", "cada empresa enxerga apenas o que é seu");
  });

  it("edição e exclusão de grupo alheio são 'não encontrada' e não mudam nada", async () => {
    const { all } = await dbm();
    const { editarTransferencia, excluirTransferencia } = await carregar("src/lib/transferencias.ts");
    const a = await novaConta("A", { inicial: 50000 });
    const b = await novaConta("B");
    const r = await criarOk({ origemId: a, destinoId: b, valorCents: 10000, data: "2026-09-20" });
    const antes = await all<any>(`SELECT * FROM payments WHERE transfer_group = ? ORDER BY id`, [r.grupo]);

    const e = await editarTransferencia(r.grupo, {
      origemId: a,
      destinoId: b,
      valorCents: 99999,
      data: "2026-09-25",
      userId: 20,
      companyId: 2,
      grupo: r.grupo,
    });
    const x = await excluirTransferencia(r.grupo, 2);
    assert.ok("erro" in e && /não encontrada/.test(e.erro));
    assert.ok("erro" in x && /não encontrada/.test(x.erro));
    assert.deepEqual(await all<any>(`SELECT * FROM payments WHERE transfer_group = ? ORDER BY id`, [r.grupo]), antes);
  });

  it("grupo legado da migração Lima's segue listável, editável e excluível", async () => {
    const { insert } = await dbm();
    const { listarTransferencias, editarTransferencia, excluirTransferencia } = await carregar("src/lib/transferencias.ts");
    const a = await novaConta("Legada A", { inicial: 30000 });
    const b = await novaConta("Legada B");
    const grupo = "TF-1730000000-123456"; // formato da origem, sem uuid
    const s = await insert(
      `INSERT INTO payments (reservation_id, freight_id, amount_cents, method, paid_at, notes, account_id, created_by, company_id, transfer_group, transfer_counterpart_id)
       VALUES (NULL,NULL,?,'transferencia','2025-10-27','Transferência para Legada B',?,?,?,?,NULL)`,
      [-15000, a, 10, 1, grupo],
    );
    const e = await insert(
      `INSERT INTO payments (reservation_id, freight_id, amount_cents, method, paid_at, notes, account_id, created_by, company_id, transfer_group, transfer_counterpart_id)
       VALUES (NULL,NULL,?,'transferencia','2025-10-27','Transferência recebida de Legada A',?,?,?,?,?)`,
      [15000, b, 10, 1, grupo, s],
    );
    const { run } = await dbm();
    await run(`UPDATE payments SET transfer_counterpart_id = ? WHERE id = ?`, [s, e]);

    const lista = await listarTransferencias(1);
    assert.equal(lista.length, 1);
    assert.equal(lista[0].grupo, grupo);
    assert.equal(lista[0].valor_cents, 15000);

    const ed = await editarTransferencia(grupo, {
      origemId: a,
      destinoId: b,
      valorCents: 12000,
      data: "2025-10-28",
      userId: 10,
      companyId: 1,
      grupo,
    });
    assert.ok(!("erro" in ed), "grupo legado deve ser editável");
    assert.equal(await saldo(b), 12000);

    const ex = await excluirTransferencia(grupo, 1);
    assert.ok(!("erro" in ex));
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 0);
    assert.equal(await saldo(a), 30000, "saldo legado revertido");
  });
});

/* ------------------------------------------------------------------ */
/* 6. Indicadores: transferência não é receita nem despesa             */
/* ------------------------------------------------------------------ */

describe("receita, despesa e indicadores", () => {
  beforeEach(cenario);

  it("transferência não é receita nem despesa", async () => {
    const { scalar } = await dbm();
    const a = await novaConta("A");
    const b = await novaConta("B");
    await criarOk({ origemId: a, destinoId: b, valorCents: 40000, data: "2026-09-20" });

    const receita = Number(await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE transfer_group IS NULL`));
    const despesa = Number(await scalar<number>(`SELECT COALESCE(SUM(amount_cents),0) FROM expenses`));
    assert.equal(receita, 0, "nenhum lado da transferência entra na receita");
    assert.equal(despesa, 0, "transferência nunca gravou linha em expenses");
  });

  it("o 'recebido' do período (SQL real do dashboard) não muda com a transferência", async () => {
    const { insert, one } = await dbm();
    const { SQL_NAO_TRANSFERENCIA } = await carregar("src/lib/financeiro.ts");
    // movimentação antiga real: pagamento de reserva
    const cliente = 100;
    const reserva = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, total_cents, company_id) VALUES ('TF-100',?,'confirmada','2026-08-10',100000,1)`,
      [cliente],
    );
    const contaHist = await novaConta("Histórico");
    await insert(
      `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, account_id, company_id) VALUES (?,?, 'pix','2026-08-01',?,1)`,
      [reserva, 50000, contaHist],
    );

    const recebido = async () => {
      const r = await one<any>(
        `SELECT (SELECT COALESCE(SUM(amount_cents),0) FROM payments
                  WHERE company_id = 1 AND paid_at BETWEEN '2026-08-01' AND '2026-08-31' AND ${SQL_NAO_TRANSFERENCIA}) AS recebido`,
      );
      return Number(r.recebido);
    };

    assert.equal(await recebido(), 50000);
    const bradesco = await novaConta("Bradesco PJ");
    const carteira = await novaConta("Carteira", { cash: true });
    await criarOk({ origemId: bradesco, destinoId: carteira, valorCents: 30000, data: "2026-08-15" });
    assert.equal(await recebido(), 50000, "o recebido do período não mudou");
  });

  it("as três fontes de indicador continuam com o predicado de exclusão", () => {
    // Os indicadores do SaaS montam a exclusão a partir do contrato partilhado;
    // mudar qualquer uma sem atualizar a constante quebra o cenário acima.
    const raiz = path.resolve(".");
    const fontes = [
      "src/lib/queries.ts",
      "src/app/(app)/relatorios/page.tsx",
      "src/app/(app)/financeiro/page.tsx",
    ];
    for (const f of fontes) {
      const texto = fs.readFileSync(path.join(raiz, f), "utf8");
      assert.ok(
        texto.includes("SQL_NAO_TRANSFERENCIA"),
        `${f} deveria excluir transferências dos indicadores via SQL_NAO_TRANSFERENCIA`,
      );
    }
  });

  it("movimentações antigas permanecem intactas com a feature em uso", async () => {
    const { all, insert } = await dbm();
    const reserva = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, total_cents, company_id) VALUES ('TF-200',100,'confirmada','2026-08-10',100000,1)`,
    );
    const c = await novaConta("Histórica", { inicial: 0 });
    await insert(
      `INSERT INTO payments (reservation_id, amount_cents, method, paid_at, account_id, company_id) VALUES (?,?, 'pix','2026-08-01',?,1)`,
      [reserva, 50000, c],
    );
    const antes = await all<any>(
      `SELECT id, reservation_id, amount_cents, method, paid_at, account_id, transfer_group, transfer_counterpart_id FROM payments ORDER BY id`,
    );

    const a = await novaConta("A");
    const b = await novaConta("B");
    const r = await criarOk({ origemId: a, destinoId: b, valorCents: 7000, data: "2026-09-21" });
    const { excluirTransferencia } = await carregar("src/lib/transferencias.ts");
    await excluirTransferencia(r.grupo, 1);

    const depois = await all<any>(
      `SELECT id, reservation_id, amount_cents, method, paid_at, account_id, transfer_group, transfer_counterpart_id FROM payments ORDER BY id`,
    );
    assert.deepEqual(depois, antes, "nenhum lançamento antigo foi alterado");
  });
});

/* ------------------------------------------------------------------ */
/* 7. Actions reais: permissão, tenant, idempotência, feedback         */
/* ------------------------------------------------------------------ */

describe("actions de transferência — permissão e tenant", () => {
  beforeEach(cenario);

  const formTransferencia = (campos: Record<string, string>) =>
    fd({ de: "2026-09-01", ate: "2026-09-30", amount: "150,00", date: "2026-09-21", ...campos });

  it("owner transfere: redirect de sucesso e evento gravado na própria empresa", async () => {
    const { transferirValor } = await carregar("src/app/(app)/financeiro/transferencias-actions.ts");
    const origem = await novaConta("Bradesco", { inicial: 100000 });
    const destino = await novaConta("Carteira", { cash: true });
    sessaoAtual = SESSAO_UM;

    const url = await redirecionado(() =>
      transferirValor(
        formTransferencia({
          origem_id: String(origem),
          destino_id: String(destino),
          grupo: "TF-1-" + crypto.randomUUID(),
        }),
      ),
    );
    assert.match(url, /aba=transferencias/);
    assert.match(url, /ok=/);
    assert.equal(await saldo(destino), 15000);
    assert.equal(await saldo(origem), 85000);
  });

  it("papel financeiro transfere; operacional NÃO (matriz real)", async () => {
    const { transferirValor } = await carregar("src/app/(app)/financeiro/transferencias-actions.ts");
    const origem = await novaConta("Bradesco", { inicial: 100000 });
    const destino = await novaConta("Carteira", { cash: true });

    sessaoAtual = SESSAO_FIN;
    const url = await redirecionado(() =>
      transferirValor(formTransferencia({ origem_id: String(origem), destino_id: String(destino), grupo: "TF-1-" + crypto.randomUUID() })),
    );
    assert.match(url, /ok=/);

    sessaoAtual = SESSAO_OPE;
    assert.ok(
      await lancouPermissao(() =>
        transferirValor(formTransferencia({ origem_id: String(origem), destino_id: String(destino), grupo: "TF-1-" + crypto.randomUUID() })),
      ),
      "operacional não movimenta financeiro",
    );
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 2, "só o envio do papel financeiro gravou");
  });

  it("IDOR: id de conta de outra empresa no form não movimenta o vizinho", async () => {
    const { transferirValor } = await carregar("src/app/(app)/financeiro/transferencias-actions.ts");
    const minha = await novaConta("Minha", { inicial: 100000 });
    const alheia = await novaConta("Alheia", { empresa: 2, inicial: 777000 });
    sessaoAtual = SESSAO_UM;

    const url = await redirecionado(() =>
      transferirValor(formTransferencia({ origem_id: String(minha), destino_id: String(alheia), grupo: "TF-1-" + crypto.randomUUID() })),
    );
    assert.match(url, /erro=/);
    assert.match(texto(url), /não encontrada/);
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 0);
    assert.equal(await saldo(alheia), 777000, "a conta da outra empresa ficou intacta");
  });

  it("reenvio do MESMO formulário (clique duplo) confirma sem duplicar", async () => {
    const { transferirValor } = await carregar("src/app/(app)/financeiro/transferencias-actions.ts");
    const origem = await novaConta("Bradesco", { inicial: 100000 });
    const destino = await novaConta("Carteira", { cash: true });
    sessaoAtual = SESSAO_UM;
    const grupo = "TF-1-" + crypto.randomUUID();
    const form = () => formTransferencia({ origem_id: String(origem), destino_id: String(destino), grupo });

    const url1 = await redirecionado(() => transferirValor(form()));
    const url2 = await redirecionado(() => transferirValor(form()));
    assert.match(texto(url1), /realizada/);
    assert.match(texto(url2), /já havia sido registrado/);
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 2, "dois lados, nunca quatro");
    assert.equal(await saldo(destino), 15000);
  });

  it("valor ilegível vira mensagem clara, nada é gravado", async () => {
    const { transferirValor } = await carregar("src/app/(app)/financeiro/transferencias-actions.ts");
    const origem = await novaConta("Bradesco", { inicial: 100000 });
    const destino = await novaConta("Carteira");
    sessaoAtual = SESSAO_UM;
    const url = await redirecionado(() =>
      transferirValor(formTransferencia({ origem_id: String(origem), destino_id: String(destino), amount: "abc", grupo: "TF-1-" + crypto.randomUUID() })),
    );
    assert.match(texto(url), /Não consegui ler o valor/);
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 0);
  });

  it("editar e excluir de outra empresa são recusados pela action", async () => {
    const { editarTransferenciaAction, excluirTransferenciaAction } = await carregar(
      "src/app/(app)/financeiro/transferencias-actions.ts",
    );
    const a = await novaConta("A", { inicial: 50000 });
    const b = await novaConta("B");
    const r = await criarOk({ origemId: a, destinoId: b, valorCents: 10000, data: "2026-09-20" });
    const { all } = await dbm();
    const antes = await all<any>(`SELECT * FROM payments WHERE transfer_group = ? ORDER BY id`, [r.grupo]);

    sessaoAtual = SESSAO_DOIS; // owner da OUTRA empresa
    const urlEd = await redirecionado(() =>
      editarTransferenciaAction(formTransferencia({ grupo: r.grupo, origem_id: String(a), destino_id: String(b) })),
    );
    const urlEx = await redirecionado(() => excluirTransferenciaAction(fd({ grupo: r.grupo })));
    assert.match(texto(urlEd), /não encontrada/);
    assert.match(texto(urlEx), /não encontrada/);
    assert.deepEqual(await all<any>(`SELECT * FROM payments WHERE transfer_group = ? ORDER BY id`, [r.grupo]), antes);
  });

  it("excluir exige admin/owner: papel financeiro não apaga lançamento", async () => {
    const { excluirTransferenciaAction } = await carregar("src/app/(app)/financeiro/transferencias-actions.ts");
    const a = await novaConta("A", { inicial: 50000 });
    const b = await novaConta("B");
    const r = await criarOk({ origemId: a, destinoId: b, valorCents: 10000, data: "2026-09-20" });

    sessaoAtual = SESSAO_FIN;
    assert.ok(await lancouPermissao(() => excluirTransferenciaAction(fd({ grupo: r.grupo }))));
    assert.equal(await contar(`SELECT COUNT(*) FROM payments WHERE transfer_group = ?`, [r.grupo]), 2, "nada foi apagado");

    sessaoAtual = SESSAO_UM;
    const url = await redirecionado(() => excluirTransferenciaAction(fd({ grupo: r.grupo })));
    assert.match(texto(url), /excluída/);
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 0);
    assert.equal(await saldo(a), 50000, "saldos revertidos");
  });

  it("toda transferência gravada pela action gera registro de auditoria", async () => {
    const { transferirValor } = await carregar("src/app/(app)/financeiro/transferencias-actions.ts");
    const origem = await novaConta("Bradesco", { inicial: 100000 });
    const destino = await novaConta("Carteira");
    sessaoAtual = SESSAO_UM;
    await redirecionado(() =>
      transferirValor(formTransferencia({ origem_id: String(origem), destino_id: String(destino), grupo: "TF-1-" + crypto.randomUUID() })),
    );
    const { one } = await dbm();
    const log = await one<any>(`SELECT * FROM audit_logs WHERE entity = 'transferencia' ORDER BY id DESC LIMIT 1`);
    assert.ok(log, "auditoria registra a transferência");
    assert.equal(log.user_id, 10);
    assert.equal(log.company_id_ref, 1);
    assert.match(log.summary, /transferiu/);
  });
});

/* ------------------------------------------------------------------ */
/* 8. Actions de contas: permissão, feedback, tenant                   */
/* ------------------------------------------------------------------ */

describe("actions de contas — Configurações › Contas", () => {
  beforeEach(cenario);

  it("criar conta grava empresa, natureza em espécie e auditoria", async () => {
    const { createAccount } = await carregar("src/app/(app)/compras/actions.ts");
    const { one } = await dbm();
    sessaoAtual = SESSAO_UM;

    const url = await redirecionado(() =>
      createAccount(
        fd({ name: "Carteira da Loja", kind: "dinheiro", initial_balance: "350,00", is_cash_account: "1" }),
      ),
    );
    assert.match(url, /ok=/);
    const c = await one<any>(`SELECT * FROM financial_accounts WHERE name = 'Carteira da Loja'`);
    assert.equal(c.company_id, 1);
    assert.equal(c.is_cash_account, 1);
    assert.equal(c.initial_balance_cents, 35000);
    const log = await one<any>(`SELECT * FROM audit_logs WHERE entity = 'conta' AND action = 'criar' ORDER BY id DESC LIMIT 1`);
    assert.ok(log && log.entity_id === c.id);
  });

  it("saldo inicial ilegível é recusado com mensagem clara", async () => {
    const { createAccount } = await carregar("src/app/(app)/compras/actions.ts");
    sessaoAtual = SESSAO_UM;
    const url = await redirecionado(() => createAccount(fd({ name: "Inválida", initial_balance: "abc" })));
    assert.match(texto(url), /saldo inicial/);
    assert.equal(await contar(`SELECT COUNT(*) FROM financial_accounts WHERE name = 'Inválida'`), 0);
  });

  it("operacional não cadastra conta (assertAdmin)", async () => {
    const { createAccount } = await carregar("src/app/(app)/compras/actions.ts");
    sessaoAtual = SESSAO_OPE;
    assert.ok(await lancouPermissao(() => createAccount(fd({ name: "Bloqueada" }))));
    assert.equal(await contar(`SELECT COUNT(*) FROM financial_accounts WHERE name = 'Bloqueada'`), 0);
  });

  it("IDOR: editar id de conta alheia responde 'não encontrada' e não toca na conta", async () => {
    const { updateAccount } = await carregar("src/app/(app)/compras/actions.ts");
    const { one } = await dbm();
    const alheia = await novaConta("Conta Alheia", { empresa: 2, inicial: 888000 });
    sessaoAtual = SESSAO_UM; // empresa 1 tentando editar a conta da empresa 2

    const url = await redirecionado(() =>
      updateAccount(fd({ id: String(alheia), name: "Hacked", initial_balance: "0,00" })),
    );
    assert.match(texto(url), /não encontrada/);
    const c = await one<any>(`SELECT * FROM financial_accounts WHERE id = ?`, [alheia]);
    assert.equal(c.name, "Conta Alheia");
    assert.equal(c.initial_balance_cents, 888000);
  });

  it("editar: nome, saldo inicial e natureza (desmarcar espécie via marcador)", async () => {
    const { updateAccount } = await carregar("src/app/(app)/compras/actions.ts");
    const { one } = await dbm();
    const id = await novaConta("Velha", { inicial: 10000, cash: true });
    sessaoAtual = SESSAO_UM;

    const url = await redirecionado(() =>
      updateAccount(
        fd({
          id: String(id),
          name: "Velha Renomeada",
          kind: "banco",
          initial_balance: "20,00",
          notes: "ajuste",
          is_cash_account_presente: "1",
          // checkbox NÃO enviado = desmarcado (o marcador faz o POST existir)
        }),
      ),
    );
    assert.match(url, /ok=/);
    const c = await one<any>(`SELECT * FROM financial_accounts WHERE id = ?`, [id]);
    assert.equal(c.name, "Velha Renomeada");
    assert.equal(c.initial_balance_cents, 2000);
    assert.equal(c.is_cash_account, 0, "desmarcar espécie viaja no POST graças ao marcador");
    const log = await one<any>(`SELECT * FROM audit_logs WHERE entity = 'conta' AND action = 'editar' ORDER BY id DESC LIMIT 1`);
    assert.ok(log && /desmarcou dinheiro em espécie/.test(log.summary));
  });
});

/* ------------------------------------------------------------------ */
/* 9. Guardas dos caminhos genéricos de pagamento                      */
/* ------------------------------------------------------------------ */

describe("guardas — nenhum caminho genérico quebra a transferência", () => {
  beforeEach(cenario);

  it("deletePayment não apaga um lado de transferência", async () => {
    const { deletePayment } = await carregar("src/app/(app)/reservas/actions.ts");
    const { one } = await dbm();
    const a = await novaConta("A", { inicial: 50000 });
    const b = await novaConta("B");
    const r = await criarOk({ origemId: a, destinoId: b, valorCents: 10000, data: "2026-09-20" });
    sessaoAtual = SESSAO_UM;

    const lado = await one<any>(`SELECT id FROM payments WHERE transfer_group = ? AND amount_cents < 0`, [r.grupo]);
    await deletePayment(fd({ payment_id: String(lado.id) }));

    assert.equal(await contar(`SELECT COUNT(*) FROM payments WHERE transfer_group = ?`, [r.grupo]), 2, "o evento permanece completo");
    assert.equal(await saldo(a), 40000);
    assert.equal(await saldo(b), 10000);
  });

  it("deletePayment de pagamento comum continua funcionando (regressão)", async () => {
    const { deletePayment } = await carregar("src/app/(app)/reservas/actions.ts");
    const { insert, one } = await dbm();
    const id = await insert(
      `INSERT INTO payments (reservation_id, freight_id, amount_cents, method, paid_at, company_id) VALUES (NULL,NULL,5000,'pix','2026-09-20',1)`,
    );
    sessaoAtual = SESSAO_UM;
    await deletePayment(fd({ payment_id: String(id) }));
    assert.equal(await one(`SELECT id FROM payments WHERE id = ?`, [id]), undefined);
  });

  it("estornarRecebimento recusa lado de transferência", async () => {
    const { estornarRecebimento } = await carregar("src/app/(app)/financeiro/receber-actions.ts");
    const { one } = await dbm();
    const a = await novaConta("A", { inicial: 50000 });
    const b = await novaConta("B");
    const r = await criarOk({ origemId: a, destinoId: b, valorCents: 10000, data: "2026-09-20" });
    sessaoAtual = SESSAO_UM;

    const lado = await one<any>(`SELECT id FROM payments WHERE transfer_group = ? AND amount_cents >= 0`, [r.grupo]);
    assert.ok(await lancouPermissao(() => estornarRecebimento(fd({ payment_id: String(lado.id) }))));
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 2, "nenhum estorno foi criado");
    assert.equal(await saldo(b), 10000);
  });

  it("estornarRecebimento de recebimento comum continua funcionando (regressão)", async () => {
    const { estornarRecebimento } = await carregar("src/app/(app)/financeiro/receber-actions.ts");
    const { insert } = await dbm();
    const id = await insert(
      `INSERT INTO payments (reservation_id, freight_id, amount_cents, method, paid_at, company_id) VALUES (NULL,NULL,7000,'pix','2026-09-20',1)`,
    );
    sessaoAtual = SESSAO_UM;
    await estornarRecebimento(fd({ payment_id: String(id) }));
    assert.equal(await contar(`SELECT COUNT(*) FROM payments`), 2, "pagamento + estorno");
    assert.equal(await contar(`SELECT COUNT(*) FROM payments WHERE amount_cents = -7000`), 1);
  });
});

/* ------------------------------------------------------------------ */
/* 10. Migrações: colunas e índices existem no schema de teste         */
/* ------------------------------------------------------------------ */

describe("migrações 0047/0049 — schema pronto para a feature", () => {
  beforeEach(cenario);

  it("colunas da 0047 existem com default neutro (compatibilidade)", async () => {
    const { insert, one } = await dbm();
    const id = await novaConta("Sem Natureza", { inicial: 100 });
    const c = await one<any>(`SELECT * FROM financial_accounts WHERE id = ?`, [id]);
    assert.equal(c.is_cash_account, 0, "nenhuma conta antiga muda sozinha");
    const pid = await insert(
      `INSERT INTO payments (reservation_id, freight_id, amount_cents, method, paid_at, company_id) VALUES (NULL,NULL,100,'pix','2026-09-20',1)`,
    );
    const p = await one<any>(`SELECT transfer_group, transfer_counterpart_id FROM payments WHERE id = ?`, [pid]);
    assert.equal(p.transfer_group, null, "lançamento comum continua comum");
  });

  it("índices da 0049 presentes (listagem rápida + barreira única)", async () => {
    const { all } = await dbm();
    const idx = (await all<any>(`SELECT name FROM sqlite_master WHERE type = 'index'`)).map((i) => i.name);
    assert.ok(idx.includes("idx_pay_transfer_group"));
    assert.ok(idx.includes("idx_pay_transfer_saida_unica"));
  });
});
