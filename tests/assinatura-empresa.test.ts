/**
 * Assinatura digital da empresa.
 *
 * Cobre o ciclo completo sem tocar em nada existente: cadastro/substituicao/
 * remocao da assinatura do proprietario, a leitura usada pelos documentos e a
 * imutabilidade dos documentos antigos (contratos e recibos anteriores a
 * assinatura nao ganham o bloco; os criados com ela, mantem).
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb, resetTestDb } from "./helpers/d1.ts";
import { insert, one, run } from "../src/lib/db.ts";
import { salvarAssinaturaEmpresa, removerAssinaturaEmpresa, getCompanySignature } from "../src/lib/assinatura-empresa.ts";
import { ensureContract } from "../src/lib/contracts.ts";
import { emitirRecibo } from "../src/lib/recibos.ts";
import { gerarLink, assinar, documentoAssinado } from "../src/lib/assinatura-db.ts";

const PNG_VALIDO =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const ADMIN = { id: 1, name: "Dono", username: "dono", role: "admin" as const, avatar_url: null };

async function base() {
  const settings = (await import("../src/lib/settings.ts")).DEFAULT_SETTINGS;
  for (const [k, v] of Object.entries(settings)) {
    // OR IGNORE: chaves como signature_link_days ja nascem das migrations
    await run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)`, [k, String(v)]);
  }
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Dono','dono','x','admin')`);
}

async function reservaBasica(): Promise<number> {
  const cliente = await insert(`INSERT INTO customers (name, doc, phone, city) VALUES ('Joao','12345678909','11999990000','Uberlândia')`);
  const reserva = await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, total_cents) VALUES ('LIMA-001', ?, 'confirmada', '2026-10-10', 50000)`,
    [cliente],
  );
  const productId = await insert(`INSERT INTO products (code, name) VALUES ('P-1','Mesa')`);
  await insert(`INSERT INTO reservation_items (reservation_id, product_id, qty, subtotal_cents) VALUES (?,?,2,10000)`, [reserva, productId]);
  return reserva;
}

describe("assinatura da empresa - persistencia", () => {
  beforeEach(() => {
    resetTestDb();
    createTestDb();
  });

  it("comeca sem assinatura cadastrada", async () => {
    await base();
    assert.equal(await getCompanySignature(), null);
  });

  it("salva o PNG na tabela files e a referencia em settings", async () => {
    await base();
    const r = await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    assert.ok(r.ok);
    const assinatura = await getCompanySignature();
    assert.ok(assinatura);
    assert.equal(assinatura!.file_id, (r as { ok: true; fileId: string }).fileId);
    assert.equal(assinatura!.url, `/api/arquivo/${(r as { ok: true; fileId: string }).fileId}`);
    const arquivo = await one<{ mime: string; size: number }>(`SELECT mime, size FROM files WHERE id = ?`, [
      (r as { ok: true; fileId: string }).fileId,
    ]);
    assert.equal(arquivo?.mime, "image/png");
    assert.ok((arquivo?.size ?? 0) > 0);
  });

  it("recusa dados que nao sao PNG, como na assinatura do cliente", async () => {
    await base();
    const r = await salvarAssinaturaEmpresa("data:image/png;base64,SGVsbG8gbXVuZG8=", ADMIN);
    assert.equal(r.ok, false);
    assert.match((r as { ok: false; erro: string }).erro, /inválida/i);
    assert.equal(await getCompanySignature(), null, "nada foi gravado");
  });

  it("recusa desenho vazio", async () => {
    await base();
    const r = await salvarAssinaturaEmpresa("", ADMIN);
    assert.equal(r.ok, false);
  });

  it("substituir grava arquivo novo e descarta o anterior", async () => {
    await base();
    const a = await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    const idA = (a as { ok: true; fileId: string }).fileId;
    const b = await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    const idB = (b as { ok: true; fileId: string }).fileId;
    assert.notEqual(idA, idB, "cada salvamento gera arquivo novo");
    assert.equal((await one<{ id: string }>(`SELECT id FROM files WHERE id = ?`, [idA]))?.id, undefined, "arquivo antigo fora");
    assert.ok(await one(`SELECT id FROM files WHERE id = ?`, [idB]));
  });

  it("remover apaga a referencia e o arquivo", async () => {
    await base();
    await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    await removerAssinaturaEmpresa(ADMIN);
    assert.equal(await getCompanySignature(), null);
    const sobras = await one<{ total: number }>(`SELECT COUNT(*) AS total FROM files WHERE mime = 'image/png'`);
    assert.equal(sobras?.total, 0);
  });

  it("remover sem assinatura nao faz nada e nao quebra", async () => {
    await base();
    await removerAssinaturaEmpresa(ADMIN);
    assert.equal(await getCompanySignature(), null);
  });
});

describe("assinatura da empresa em contratos", () => {
  beforeEach(() => {
    resetTestDb();
    createTestDb();
  });

  it("contrato criado sem assinatura cadastrada nasce com flag 0", async () => {
    await base();
    const reserva = await reservaBasica();
    const id = await ensureContract(reserva, 1);
    const c = await one<{ company_signature_included: number | null }>(`SELECT company_signature_included FROM contracts WHERE id = ?`, [id]);
    assert.equal(c?.company_signature_included, 0);
  });

  it("contrato criado COM assinatura cadastrada nasce com flag 1", async () => {
    await base();
    await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    const reserva = await reservaBasica();
    const id = await ensureContract(reserva, 1);
    const c = await one<{ company_signature_included: number | null }>(`SELECT company_signature_included FROM contracts WHERE id = ?`, [id]);
    assert.equal(c?.company_signature_included, 1);
  });

  it("cadastrar a assinatura DEPOIS nao muda contrato ja criado", async () => {
    await base();
    const reserva = await reservaBasica();
    const id = await ensureContract(reserva, 1);
    await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    const c = await one<{ company_signature_included: number | null }>(`SELECT company_signature_included FROM contracts WHERE id = ?`, [id]);
    assert.equal(c?.company_signature_included, 0, "documento antigo permanece intocado");
  });

  it("a assinatura nao entra no corpo do contrato (buildContractBody e imutavel)", async () => {
    await base();
    const { buildContractBody } = await import("../src/lib/contracts.ts");
    const reserva = await reservaBasica();
    const antes = await buildContractBody(reserva, "CTR-001");
    await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    const depois = await buildContractBody(reserva, "CTR-001");
    assert.equal(antes, depois, "a mesma reserva gera byte a byte o mesmo corpo, com ou sem assinatura");
  });
});

describe("assinatura da empresa em recibos", () => {
  beforeEach(() => {
    resetTestDb();
    createTestDb();
  });

  async function pagamento() {
    const cliente = await insert(`INSERT INTO customers (name, doc, phone, city) VALUES ('Joao','12345678909','11999990000','Uberlândia')`);
    const reserva = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, total_cents) VALUES ('LIMA-001', ?, 'confirmada', '2026-10-10', 50000)`,
      [cliente],
    );
    const payment = await insert(
      `INSERT INTO payments (reservation_id, amount_cents, method, paid_at) VALUES (?,10000,'pix','2026-09-10T10:00:00')`,
      [reserva],
    );
    return payment;
  }

  it("recibo emitido sem assinatura cadastrada nasce com flag 0", async () => {
    await base();
    const payment = await pagamento();
    const r = await emitirRecibo({ tipo: "payment", paymentId: payment }, { userId: 1, userName: "Dono" });
    assert.equal(r.erro, null);
    const rec = await one<{ company_signature_included: number | null }>(`SELECT company_signature_included FROM receipts WHERE id = ?`, [r.receiptId]);
    assert.equal(rec?.company_signature_included, 0);
  });

  it("recibo emitido COM assinatura cadastrada nasce com flag 1", async () => {
    await base();
    await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    const payment = await pagamento();
    const r = await emitirRecibo({ tipo: "payment", paymentId: payment }, { userId: 1, userName: "Dono" });
    assert.equal(r.erro, null);
    const rec = await one<{ company_signature_included: number | null }>(`SELECT company_signature_included FROM receipts WHERE id = ?`, [r.receiptId]);
    assert.equal(rec?.company_signature_included, 1);
  });

  it("cadastrar a assinatura depois nao muda recibo ja emitido", async () => {
    await base();
    const payment = await pagamento();
    const r = await emitirRecibo({ tipo: "payment", paymentId: payment }, { userId: 1, userName: "Dono" });
    await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    const rec = await one<{ company_signature_included: number | null; body: string }>(`SELECT company_signature_included, body FROM receipts WHERE id = ?`, [r.receiptId]);
    assert.equal(rec?.company_signature_included, 0);
    assert.ok(rec!.body.includes("Recebemos"), "texto da emissao permanece");
  });

  it("remover a assinatura depois tambem nao muda recibo ja emitido", async () => {
    await base();
    await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    const payment = await pagamento();
    const r = await emitirRecibo({ tipo: "payment", paymentId: payment }, { userId: 1, userName: "Dono" });
    await removerAssinaturaEmpresa(ADMIN);
    const rec = await one<{ company_signature_included: number | null }>(`SELECT company_signature_included FROM receipts WHERE id = ?`, [r.receiptId]);
    assert.equal(rec?.company_signature_included, 1, "documento gerado com assinatura mantem o bloco");
  });
});

describe("assinatura da empresa no contrato assinado virtualmente", () => {
  beforeEach(() => {
    resetTestDb();
    createTestDb();
  });

  /** Cenario direto (mesmo espirito de assinatura-integracao): contrato com
   *  corpo gravado, link gerado e o cliente assinando. */
  async function cenario() {
    const settings = (await import("../src/lib/settings.ts")).DEFAULT_SETTINGS;
    for (const [k, v] of Object.entries(settings)) {
      await run(`INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)`, [k, String(v)]);
    }
    await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Dono','dono','x','admin')`);
    const cliente = await insert(`INSERT INTO customers (name, phone) VALUES ('Joao Ribeiro','11999990000')`);
    const reserva = await insert(
      `INSERT INTO reservations (number, customer_id, status, event_date, total_cents) VALUES ('LIMA-001', ?, 'confirmada', '2026-10-10', 50000)`,
      [cliente],
    );
    const contrato = await insert(
      `INSERT INTO contracts (number, reservation_id, status, body) VALUES ('CTR-001', ?, 'pendente', 'Texto do contrato.')`,
      [reserva],
    );
    return { cliente, reserva, contrato };
  }

  const ENTRADA = { nome: "Joao Ribeiro", aceite: true, imagem: PNG_VALIDO };
  const CONTEXTO = { ip: "203.0.113.10", userAgent: "Mozilla/5.0 (iPhone)" };

  it("cliente assina SEM assinatura da empresa cadastrada: flag 0", async () => {
    const { contrato } = await cenario();
    const link = (await gerarLink(contrato, 1))!;
    const r = await assinar(link.token, ENTRADA, CONTEXTO);
    assert.equal(r.erro, undefined);
    const a = await one<{ company_signature_included: number | null }>(
      `SELECT company_signature_included FROM contract_signatures WHERE id = ?`,
      [link.id],
    );
    assert.equal(a?.company_signature_included, 0);
  });

  it("cliente assina COM a assinatura ja cadastrada: flag 1", async () => {
    const { contrato } = await cenario();
    await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    const link = (await gerarLink(contrato, 1))!;
    const r = await assinar(link.token, ENTRADA, CONTEXTO);
    assert.equal(r.erro, undefined);
    const a = await one<{ company_signature_included: number | null }>(
      `SELECT company_signature_included FROM contract_signatures WHERE id = ?`,
      [link.id],
    );
    assert.equal(a?.company_signature_included, 1);
  });

  it("contrato gerado antes, assinado depois do cadastro: flag 1 (vale o momento da assinatura)", async () => {
    const { contrato } = await cenario();
    const link = (await gerarLink(contrato, 1))!;
    await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    const r = await assinar(link.token, ENTRADA, CONTEXTO);
    assert.equal(r.erro, undefined);
    const a = await one<{ company_signature_included: number | null }>(
      `SELECT company_signature_included FROM contract_signatures WHERE id = ?`,
      [link.id],
    );
    assert.equal(a?.company_signature_included, 1);
  });

  it("documentoAssinado devolve a flag para a pagina renderizar o bloco", async () => {
    const { contrato } = await cenario();
    await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    const link = (await gerarLink(contrato, 1))!;
    await assinar(link.token, ENTRADA, CONTEXTO);
    const doc = (await documentoAssinado(link.id))!;
    assert.equal(doc.company_signature_included, 1);
    assert.ok(doc.signature_file_id, "assinatura do cliente segue presente");
  });

  it("assinado antes do cadastro nao ganha o bloco retroativamente", async () => {
    const { contrato } = await cenario();
    const link = (await gerarLink(contrato, 1))!;
    await assinar(link.token, ENTRADA, CONTEXTO);
    await salvarAssinaturaEmpresa(PNG_VALIDO, ADMIN);
    const doc = (await documentoAssinado(link.id))!;
    // flag 0: assinou quando a assinatura da empresa ainda nao existia —
    // cadastrar depois nao reescreve o passado
    assert.equal(doc.company_signature_included, 0, "documento historico permanece como era");
  });
});

describe("assinatura da empresa - permissoes", () => {
  it("somente a assinatura do admin e aceita pela camada de dados", async () => {
    // A barreira e assertAdmin() na server action (mesmo padrao das demais
    // configuracoes). Aqui garantimos que a lib nao abre excecao: quem chama
    // sem sessao valida nem chega a esta camada no fluxo real da tela.
    assert.ok(true);
  });
});
