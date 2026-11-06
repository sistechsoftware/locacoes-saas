/**
 * Substituicao de contrato: revogacao logica com linhagem, sem apagar nada.
 *
 * O caso real (LIMA-064 / CTR-063) e este: contrato ja assinado, dados
 * cadastrais da empresa mudaram e o documento vigente ficou desatualizado.
 * A substituicao precisa aposentar o antigo sem tocar na reserva, no
 * financeiro nem na prova do que o cliente leu e aceitou.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { insert, one, run, scalar } from "../src/lib/db.ts";
import { substituirContrato } from "../src/lib/contracts.ts";
import { assinar, documentoAssinado, gerarLink } from "../src/lib/assinatura-db.ts";

/** PNG 1x1 valido, do jeito que o canvas manda. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const ENTRADA = { nome: "Roseni Araujo", aceite: true, imagem: PNG };
const CONTEXTO = { ip: "203.0.113.9", userAgent: "Mozilla/5.0 (teste)" };

let cliente = 0;
let reserva = 0;
let contrato = 0;

async function cenario({ assinado = false }: { assinado?: boolean } = {}) {
  createTestDb();
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
  // dado ATUAL da empresa: e o que o contrato novo precisa carregar
  await run(
    `INSERT INTO company_settings (company_id, key, value) VALUES (1,'company_name','Locações para Festas Udi')
       ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`,
  );
  await run(
    `INSERT INTO company_settings (company_id, key, value) VALUES (1,'company_doc','40.226.211/0001-61')
       ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`,
  );

  cliente = await insert(`INSERT INTO customers (name, phone) VALUES ('Roseni Araujo','34999990000')`);
  reserva = await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, total_cents, company_id)
     VALUES ('LIMA-064', ?, 'confirmada', '2026-12-31', 24200, 1)`,
    [cliente],
  );
  const produto = await insert(`INSERT INTO products (code, name, total_qty) VALUES ('MESA','Mesa',10)`);
  await insert(
    `INSERT INTO reservation_items (reservation_id, product_id, qty, unit_price_cents, subtotal_cents, company_id)
     VALUES (?,?,3,8067,24200,1)`,
    [reserva, produto],
  );
  await insert(
    `INSERT INTO payments (reservation_id, amount_cents, method, paid_at) VALUES (?,7260,'pix','2026-11-04')`,
    [reserva],
  );
  await insert(`INSERT INTO deposits (reservation_id, amount_cents, status) VALUES (?,5000,'recebida')`, [reserva]);

  contrato = await insert(
    `INSERT INTO contracts (number, reservation_id, status, body, company_id)
     VALUES ('CTR-063', ?, 'pendente', 'LOCADORA: Lima’s Locações, CNPJ 40.226.211/0001-61.', 1)`,
    [reserva],
  );

  if (assinado) {
    const link = await gerarLink(contrato, 1);
    const r = await assinar(link!.token, ENTRADA, CONTEXTO);
    assert.ok(r.ok, "cenario: assinatura inicial precisa concluir");
  }
}

describe("substituicao de contrato", () => {
  beforeEach(async () => {
    await cenario();
  });

  it("revoga o antigo com linhagem e cria o novo com os dados atuais", async () => {
    const r = await substituirContrato(contrato, 1, { id: 1 }, "dados cadastrais da locadora atualizados");
    assert.ok(r.ok);
    if (!r.ok) return;

    const antigo = await one<any>(`SELECT * FROM contracts WHERE id=?`, [contrato]);
    const novo = await one<any>(`SELECT * FROM contracts WHERE id=?`, [r.novoId]);

    assert.equal(antigo.status, "cancelado");
    assert.ok(antigo.revoked_at, "revogacao precisa de data");
    assert.equal(antigo.revoked_reason, "dados cadastrais da locadora atualizados");
    assert.equal(antigo.revoked_by, 1);
    assert.equal(antigo.superseded_by_id, r.novoId);
    assert.equal(antigo.body, "LOCADORA: Lima’s Locações, CNPJ 40.226.211/0001-61.", "corpo antigo nao e reescrito");

    assert.equal(novo.status, "pendente");
    assert.equal(novo.replaces_id, contrato);
    assert.notEqual(novo.number, "CTR-063", "o substituto recebe numero novo");
    assert.match(novo.body, /Locações para Festas Udi/, "o novo usa o cadastro atual");
    assert.equal(novo.reservation_id, reserva);
  });

  it("nao altera reserva, itens, pagamentos, adiantamentos nem caucao", async () => {
    const antes = await one<any>(
      `SELECT r.status, r.event_date, r.total_cents,
              (SELECT COUNT(*) FROM reservation_items i WHERE i.reservation_id = r.id) AS itens,
              (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.reservation_id = r.id) AS pago,
              (SELECT COALESCE(SUM(amount_cents),0) FROM deposits d WHERE d.reservation_id = r.id) AS caucao
         FROM reservations r WHERE r.id = ?`,
      [reserva],
    );

    const r = await substituirContrato(contrato, 1, { id: 1 }, "mudanca de razao social");
    assert.ok(r.ok);

    const depois = await one<any>(
      `SELECT r.status, r.event_date, r.total_cents,
              (SELECT COUNT(*) FROM reservation_items i WHERE i.reservation_id = r.id) AS itens,
              (SELECT COALESCE(SUM(amount_cents),0) FROM payments p WHERE p.reservation_id = r.id) AS pago,
              (SELECT COALESCE(SUM(amount_cents),0) FROM deposits d WHERE d.reservation_id = r.id) AS caucao
         FROM reservations r WHERE r.id = ?`,
      [reserva],
    );
    assert.deepEqual(depois, antes);
  });

  it("preserva a assinatura antiga: snapshot, hash e arquivo continuam intactos", async () => {
    await cenario({ assinado: true });
    const antes = await one<any>(`SELECT * FROM contract_signatures WHERE contract_id=?`, [contrato]);

    const r = await substituirContrato(contrato, 1, { id: 1 }, "nome da empresa mudou");
    assert.ok(r.ok);
    if (!r.ok) return;

    const depois = await one<any>(`SELECT * FROM contract_signatures WHERE id=?`, [antes.id]);
    assert.equal(depois.status, "assinado", "revogar o contrato nao reescreve a assinatura");
    assert.equal(depois.body_snapshot, antes.body_snapshot);
    assert.equal(depois.document_hash, antes.document_hash);
    assert.equal(depois.signature_file_id, antes.signature_file_id);
    assert.equal(depois.company_signature_included, antes.company_signature_included);

    const doc = await documentoAssinado(antes.id, 1);
    assert.ok(doc, "a via assinada continua abrindo");
    assert.equal(doc.superseded_by_id, r.novoId);
    assert.equal(doc.substituido_por_numero, r.numero);
  });

  it("revoga o link pendente e nao deixa o contrato antigo emitir outro", async () => {
    const link = await gerarLink(contrato, 1);
    assert.ok(link);

    const r = await substituirContrato(contrato, 1, { id: 1 }, "dados atualizados");
    assert.ok(r.ok);
    if (!r.ok) return;

    const assinaturaAntiga = await one<any>(`SELECT status, revoked_at FROM contract_signatures WHERE id=?`, [
      link!.id,
    ]);
    assert.equal(assinaturaAntiga.status, "revogado");
    assert.ok(assinaturaAntiga.revoked_at);
    assert.equal(await gerarLink(contrato, 1), null, "contrato substituido nao gera link");
    assert.ok(await gerarLink(r.novoId, 1), "o substituto gera link novo");
  });

  it("recusa repeticao, falta de motivo e contrato de outra empresa", async () => {
    assert.equal((await substituirContrato(contrato, 1, { id: 1 }, "   ")).ok, false, "motivo e obrigatorio");

    const r = await substituirContrato(contrato, 1, { id: 1 }, "primeira substituicao");
    assert.ok(r.ok);
    assert.equal((await substituirContrato(contrato, 1, { id: 1 }, "de novo")).ok, false, "nao substitui duas vezes");
    assert.equal((await substituirContrato(contrato, 2, { id: 1 }, "outra empresa")).ok, false, "isolamento por empresa");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM contracts WHERE reservation_id=?`, [reserva]), 2);
  });
});
