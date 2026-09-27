/**
 * Assinatura virtual com o SQL real: link, congelamento da versao assinada,
 * dupla assinatura, revogacao, expiracao e isolamento entre clientes.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createTestDb } from "./helpers/d1.ts";
import { all, insert, one, run, scalar } from "../src/lib/db.ts";
import {
  assinar,
  assinaturasDoContrato,
  documentoAssinado,
  documentosDoCliente,
  gerarLink,
  porToken,
  revogarLink,
} from "../src/lib/assinatura-db.ts";
import { sha256 } from "../src/lib/assinatura.ts";

/** PNG 1x1 valido, do jeito que o canvas manda. */
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const ENTRADA = { nome: "Joao Ribeiro", aceite: true, imagem: PNG };
const CONTEXTO = { ip: "203.0.113.10", userAgent: "Mozilla/5.0 (iPhone)" };

let cliente = 0;
let reserva = 0;
let contrato = 0;
let seq = 0;

async function cenario() {
  createTestDb();
  seq = 0;
  await insert(`INSERT INTO users (id, name, username, password_hash, role) VALUES (1,'Op','op','x','admin')`);
  cliente = await insert(`INSERT INTO customers (name, phone) VALUES ('Joao Ribeiro','11999990000')`);
  reserva = await novaReserva();
  contrato = await novoContrato(reserva, "Texto original do contrato.");
}

async function novaReserva(customerId = cliente) {
  seq++;
  return await insert(
    `INSERT INTO reservations (number, customer_id, status, event_date, total_cents)
     VALUES (?,?,'confirmada','2026-10-10',50000)`,
    [`LIMA-${String(seq).padStart(3, "0")}`, customerId],
  );
}

async function novoContrato(reservationId: number, corpo: string) {
  seq++;
  return await insert(
    `INSERT INTO contracts (number, reservation_id, status, body) VALUES (?,?,'pendente',?)`,
    [`CTR-${String(seq).padStart(3, "0")}`, reservationId, corpo],
  );
}

describe("geracao do link", () => {
  beforeEach(cenario);

  it("o token nao e gravado em texto, so o hash", async () => {
    const criado = await gerarLink(contrato, 1);
    assert.ok(criado);
    const linha = await one<any>(`SELECT token_hash FROM contract_signatures WHERE id=?`, [criado!.id]);
    assert.equal(linha.token_hash, await sha256(criado!.token));
    assert.ok(!linha.token_hash.includes(criado!.token), "o token nao pode aparecer no banco");
  });

  it("o link novo encontra o contrato certo", async () => {
    const criado = await gerarLink(contrato, 1);
    const achado = await porToken(criado!.token);
    assert.equal(achado.contract_id, contrato);
    assert.equal(achado.customer_id, cliente);
    assert.equal(achado.status, "pendente");
  });

  it("token errado nao acha nada e nao vaza qual existe", async () => {
    await gerarLink(contrato, 1);
    assert.equal(await porToken("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), undefined);
    assert.equal(await porToken("../../etc/passwd"), null, "formato invalido nem consulta");
    assert.equal(await porToken(""), null);
  });

  it("mexer no token da URL nao abre o contrato de outro cliente", async () => {
    const outro = await insert(`INSERT INTO customers (name) VALUES ('Maria')`);
    const reservaDela = await novaReserva(outro);
    const contratoDela = await novoContrato(reservaDela, "Contrato da Maria.");
    const meu = await gerarLink(contrato, 1);
    await gerarLink(contratoDela, 1);

    // trocar um caractere do token nao pode cair no contrato da Maria
    const adulterado = meu!.token.slice(0, -1) + (meu!.token.at(-1) === "a" ? "b" : "a");
    assert.equal(await porToken(adulterado), undefined);
  });

  it("gerar um link novo revoga o anterior", async () => {
    const primeiro = await gerarLink(contrato, 1);
    const segundo = await gerarLink(contrato, 1);
    assert.equal((await porToken(primeiro!.token)).status, "revogado");
    assert.equal((await porToken(segundo!.token)).status, "pendente");
  });
});

describe("assinatura", () => {
  beforeEach(cenario);

  it("assina, muda o status e registra a auditoria", async () => {
    const criado = await gerarLink(contrato, 1);
    const r = await assinar(criado!.token, ENTRADA, CONTEXTO);
    assert.equal(r.ok, true);

    const a = await one<any>(`SELECT * FROM contract_signatures WHERE id=?`, [criado!.id]);
    assert.equal(a.status, "assinado");
    assert.equal(a.signer_name, "Joao Ribeiro");
    assert.ok(a.signed_at && a.accepted_at, "data do aceite e da assinatura");
    assert.equal(a.ip_address, CONTEXTO.ip);
    assert.match(a.user_agent, /iPhone/);
    assert.equal(a.document_hash.length, 64, "hash de integridade gravado");

    const c = await one<any>(`SELECT status, signed_at FROM contracts WHERE id=?`, [contrato]);
    assert.equal(c.status, "assinado");
  });

  it("a imagem da assinatura fica guardada como PNG", async () => {
    const criado = await gerarLink(contrato, 1);
    await assinar(criado!.token, ENTRADA, CONTEXTO);
    const a = await one<any>(`SELECT signature_file_id FROM contract_signatures WHERE id=?`, [criado!.id]);
    const arquivo = await one<any>(`SELECT mime, size FROM files WHERE id=?`, [a.signature_file_id]);
    assert.equal(arquivo.mime, "image/png");
    assert.ok(arquivo.size > 0);
  });

  it("assinar sem aceitar os termos e recusado", async () => {
    const criado = await gerarLink(contrato, 1);
    const r = await assinar(criado!.token, { ...ENTRADA, aceite: false }, CONTEXTO);
    assert.match(r.erro ?? "", /leu e concorda/i);
    assert.equal((await one<any>(`SELECT status FROM contracts WHERE id=?`, [contrato])).status, "pendente");
  });

  it("assinar sem desenhar nada e recusado", async () => {
    const criado = await gerarLink(contrato, 1);
    assert.ok((await assinar(criado!.token, { ...ENTRADA, imagem: "" }, CONTEXTO)).erro);
  });

  it("arquivo que nao e PNG e recusado mesmo com o cabecalho certo", async () => {
    const criado = await gerarLink(contrato, 1);
    const falso = "data:image/png;base64," + btoa("x".repeat(300));
    assert.match((await assinar(criado!.token, { ...ENTRADA, imagem: falso }, CONTEXTO)).erro ?? "", /inválida/i);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM files`), 0, "nada foi gravado");
  });

  it("dois cliques simultaneos geram uma assinatura so", async () => {
    const criado = await gerarLink(contrato, 1);
    const [a, b] = await Promise.all([
      assinar(criado!.token, ENTRADA, CONTEXTO),
      assinar(criado!.token, ENTRADA, CONTEXTO),
    ]);
    assert.equal([a, b].filter((x) => x.ok).length, 1, "so uma pode passar");
    assert.equal([a, b].filter((x) => x.erro).length, 1);
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM customer_documents`), 1, "um documento so no historico");
    assert.equal(await scalar<number>(`SELECT COUNT(*) FROM files`), 1, "uma imagem so");
  });

  it("reabrir o link depois de assinado nao permite assinar de novo", async () => {
    const criado = await gerarLink(contrato, 1);
    await assinar(criado!.token, ENTRADA, CONTEXTO);
    const segunda = await assinar(criado!.token, { ...ENTRADA, nome: "Outra pessoa" }, CONTEXTO);
    assert.match(segunda.erro ?? "", /já foi assinado/i);
    assert.equal((await one<any>(`SELECT signer_name FROM contract_signatures WHERE id=?`, [criado!.id])).signer_name, "Joao Ribeiro");
  });
});

describe("versao assinada congelada", () => {
  beforeEach(cenario);

  it("editar o contrato depois nao altera o que foi assinado", async () => {
    const criado = await gerarLink(contrato, 1);
    await assinar(criado!.token, ENTRADA, CONTEXTO);

    await run(`UPDATE contracts SET body = ? WHERE id = ?`, ["TEXTO TOTALMENTE DIFERENTE", contrato]);

    const doc = await documentoAssinado(criado!.id);
    assert.equal(doc.body_snapshot, "Texto original do contrato.", "o snapshot nao acompanha a edicao");
    assert.notEqual(doc.body_snapshot, "TEXTO TOTALMENTE DIFERENTE");
  });

  it("o hash continua batendo com o conteudo congelado", async () => {
    const criado = await gerarLink(contrato, 1);
    await assinar(criado!.token, ENTRADA, CONTEXTO);
    const antes = await one<any>(`SELECT document_hash FROM contract_signatures WHERE id=?`, [criado!.id]);
    await run(`UPDATE contracts SET body = ? WHERE id = ?`, ["outro texto", contrato]);
    const depois = await one<any>(`SELECT document_hash FROM contract_signatures WHERE id=?`, [criado!.id]);
    assert.equal(depois.document_hash, antes.document_hash);
  });

  it("a pagina publica passa a mostrar o texto congelado", async () => {
    const criado = await gerarLink(contrato, 1);
    await assinar(criado!.token, ENTRADA, CONTEXTO);
    await run(`UPDATE contracts SET body = ? WHERE id = ?`, ["editado depois", contrato]);
    const registro = await porToken(criado!.token);
    assert.equal(registro.body_snapshot, "Texto original do contrato.");
  });
});

describe("revogacao e expiracao", () => {
  beforeEach(cenario);

  it("link revogado nao assina", async () => {
    const criado = await gerarLink(contrato, 1);
    assert.equal(await revogarLink(criado!.id), true);
    const r = await assinar(criado!.token, ENTRADA, CONTEXTO);
    assert.match(r.erro ?? "", /não é mais válido/i);
  });

  it("revogar duas vezes nao quebra nada", async () => {
    const criado = await gerarLink(contrato, 1);
    assert.equal(await revogarLink(criado!.id), true);
    assert.equal(await revogarLink(criado!.id), false);
  });

  it("link expirado nao assina", async () => {
    const criado = await gerarLink(contrato, 1);
    await run(`UPDATE contract_signatures SET expires_at = '2020-01-01T00:00:00' WHERE id = ?`, [criado!.id]);
    assert.ok((await assinar(criado!.token, ENTRADA, CONTEXTO)).erro);
  });

  it("depois de assinado o link nao pode ser revogado para reabrir", async () => {
    const criado = await gerarLink(contrato, 1);
    await assinar(criado!.token, ENTRADA, CONTEXTO);
    assert.equal(await revogarLink(criado!.id), false, "so revoga o que esta pendente");
    assert.equal((await one<any>(`SELECT status FROM contract_signatures WHERE id=?`, [criado!.id])).status, "assinado");
  });
});

describe("historico documental", () => {
  beforeEach(cenario);

  it("o contrato assinado entra no historico do cliente", async () => {
    const criado = await gerarLink(contrato, 1);
    await assinar(criado!.token, ENTRADA, CONTEXTO);
    const docs = await documentosDoCliente(cliente);
    assert.equal(docs.length, 1);
    assert.equal(docs[0].source, "assinatura_virtual");
    assert.equal(docs[0].signer_name, "Joao Ribeiro");
  });

  it("varios contratos ficam separados, nenhum substitui o outro", async () => {
    const c1 = await gerarLink(contrato, 1);
    await assinar(c1!.token, ENTRADA, CONTEXTO);

    const reserva2 = await novaReserva();
    const contrato2 = await novoContrato(reserva2, "Segundo contrato.");
    const c2 = await gerarLink(contrato2, 1);
    await assinar(c2!.token, ENTRADA, CONTEXTO);

    const docs = await documentosDoCliente(cliente);
    assert.equal(docs.length, 2);
    assert.equal(new Set(docs.map((d: any) => d.contract_id)).size, 2, "sao contratos diferentes");
  });

  it("upload manual convive com o assinado virtualmente", async () => {
    const criado = await gerarLink(contrato, 1);
    await assinar(criado!.token, ENTRADA, CONTEXTO);
    await insert(
      `INSERT INTO customer_documents (customer_id, title, source, mime, size)
       VALUES (?,'Contrato antigo em papel','upload_manual','application/pdf',12345)`,
      [cliente],
    );
    const docs = await documentosDoCliente(cliente);
    assert.equal(docs.length, 2);
    assert.deepEqual(
      new Set(docs.map((d: any) => d.source)),
      new Set(["assinatura_virtual", "upload_manual"]),
      "a origem de cada documento fica registrada",
    );
  });

  it("o historico de um cliente nao aparece no de outro", async () => {
    const criado = await gerarLink(contrato, 1);
    await assinar(criado!.token, ENTRADA, CONTEXTO);
    const outro = await insert(`INSERT INTO customers (name) VALUES ('Maria')`);
    assert.equal((await documentosDoCliente(outro)).length, 0);
  });
});

describe("contratos antigos", () => {
  beforeEach(cenario);

  it("contrato sem link continua funcionando como antes", async () => {
    const c = await one<any>(`SELECT * FROM contracts WHERE id=?`, [contrato]);
    assert.equal(c.status, "pendente");
    assert.equal((await assinaturasDoContrato(contrato)).length, 0);
    assert.equal((await documentosDoCliente(cliente)).length, 0);
  });
});
