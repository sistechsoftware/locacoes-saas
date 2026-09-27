/** Regra da assinatura virtual: token, estado do link e validacao de entrada. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bytesDaAssinatura,
  gerarToken,
  hashDocumento,
  impedimento,
  podeAssinar,
  sha256,
  TOKEN_VALIDO,
  validarDocumento,
  validarEntrada,
  type Assinatura,
} from "../src/lib/assinatura.ts";

const AGORA = "2026-09-10T14:00:00";
const pendente = (extra: Partial<Assinatura> = {}): Assinatura => ({
  status: "pendente",
  expires_at: null,
  revoked_at: null,
  signed_at: null,
  ...extra,
});

describe("token", () => {
  it("tem tamanho fixo e formato aceito", () => {
    const t = gerarToken();
    assert.equal(t.length, 32);
    assert.match(t, TOKEN_VALIDO);
  });

  it("nao repete", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => gerarToken()));
    assert.equal(tokens.size, 500);
  });

  it("nao carrega numero sequencial nem parte previsivel", () => {
    const a = gerarToken();
    const b = gerarToken();
    // dois tokens seguidos nao podem compartilhar prefixo longo
    let iguais = 0;
    while (iguais < a.length && a[iguais] === b[iguais]) iguais++;
    assert.ok(iguais < 6, "prefixos praticamente identicos indicam gerador previsivel");
  });

  it("o hash e estavel e nao devolve o token", async () => {
    const t = gerarToken();
    const h = await sha256(t);
    assert.equal(h.length, 64);
    assert.equal(h, await sha256(t), "mesmo token, mesmo hash");
    assert.ok(!h.includes(t.slice(0, 8)), "o hash nao pode conter o proprio token");
  });

  it("tokens diferentes dao hashes diferentes", async () => {
    assert.notEqual(await sha256("abc"), await sha256("abd"));
  });
});

describe("estado do link", () => {
  it("link novo pode assinar", () => {
    assert.equal(impedimento(pendente(), AGORA), null);
    assert.ok(podeAssinar(pendente(), AGORA));
  });

  it("contrato ja assinado nao aceita nova assinatura", () => {
    assert.equal(impedimento(pendente({ status: "assinado", signed_at: "2026-09-09T10:00:00" }), AGORA), "assinado");
  });

  it("link revogado e recusado", () => {
    assert.equal(impedimento(pendente({ status: "revogado", revoked_at: "2026-09-09T10:00:00" }), AGORA), "revogado");
  });

  it("link vencido e recusado", () => {
    assert.equal(impedimento(pendente({ expires_at: "2026-09-09T23:59:59" }), AGORA), "expirado");
  });

  it("no limite ainda vale", () => {
    assert.equal(impedimento(pendente({ expires_at: "2026-09-10T14:00:00" }), AGORA), null);
  });

  it("sem validade configurada o link nao expira sozinho", () => {
    assert.equal(impedimento(pendente({ expires_at: null }), "2099-01-01T00:00:00"), null);
  });

  it("assinado vence revogado e expirado na mensagem exibida", () => {
    const a = pendente({ status: "assinado", signed_at: "2026-09-01T10:00:00", expires_at: "2020-01-01T00:00:00" });
    assert.equal(impedimento(a, AGORA), "assinado", "quem ja assinou precisa ver 'ja assinado', nao 'expirado'");
  });
});

describe("validacao do que a pagina publica manda", () => {
  const pngValido =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  it("aceita uma assinatura completa", () => {
    assert.equal(validarEntrada({ nome: "Joao Ribeiro", aceite: true, imagem: pngValido }), null);
  });

  it("recusa assinar sem marcar o aceite", () => {
    const erro = validarEntrada({ nome: "Joao Ribeiro", aceite: false, imagem: pngValido });
    assert.match(erro ?? "", /leu e concorda/i);
  });

  it("recusa sem nome", () => {
    assert.match(validarEntrada({ nome: "", aceite: true, imagem: pngValido }) ?? "", /nome/i);
    assert.match(validarEntrada({ nome: "Jo", aceite: true, imagem: pngValido }) ?? "", /nome/i);
  });

  it("recusa assinatura em branco", () => {
    // nada enviado: a mensagem pede o traco, que e o que a pessoa precisa fazer
    assert.match(validarEntrada({ nome: "Joao Ribeiro", aceite: true, imagem: "" }) ?? "", /antes de confirmar/i);
    // enviado, mas nao e uma imagem de verdade
    assert.match(
      validarEntrada({ nome: "Joao Ribeiro", aceite: true, imagem: "data:image/png;base64,AA" }) ?? "",
      /inválida/i,
    );
  });

  it("recusa arquivo que nao e PNG, mesmo disfarcado", () => {
    assert.match(
      validarEntrada({ nome: "Joao Ribeiro", aceite: true, imagem: "data:text/html;base64," + "x".repeat(300) }) ?? "",
      /inválida/i,
    );
  });

  it("recusa imagem grande demais", () => {
    const enorme = "data:image/png;base64," + "A".repeat(500_000);
    assert.match(validarEntrada({ nome: "Joao", aceite: true, imagem: enorme }) ?? "", /pesada/i);
  });

  it("so aceita bytes que realmente comecam como PNG", () => {
    assert.ok(bytesDaAssinatura(pngValido), "PNG de verdade passa");
    // base64 valido, mas o conteudo nao e PNG
    assert.equal(bytesDaAssinatura("data:image/png;base64,SGVsbG8gbXVuZG8="), null);
    assert.equal(bytesDaAssinatura("data:image/jpeg;base64,/9j/4AAQ"), null);
    assert.equal(bytesDaAssinatura("nao e data url"), null);
  });
});

describe("integridade do documento", () => {
  it("o mesmo documento gera sempre o mesmo hash", async () => {
    const partes = { body: "Contrato...", signerName: "Joao", signedAt: "2026-09-10T14:00:00", signatureRef: "abc" };
    assert.equal(await hashDocumento(partes), await hashDocumento(partes));
  });

  it("mexer em qualquer parte muda o hash", async () => {
    const base = { body: "Contrato...", signerName: "Joao", signedAt: "2026-09-10T14:00:00", signatureRef: "abc" };
    const original = await hashDocumento(base);
    assert.notEqual(await hashDocumento({ ...base, body: "Contrato alterado" }), original);
    assert.notEqual(await hashDocumento({ ...base, signerName: "Maria" }), original);
    assert.notEqual(await hashDocumento({ ...base, signatureRef: "outra" }), original);
  });
});

describe("upload manual de documento", () => {
  it("aceita PDF, JPG e PNG", () => {
    for (const mime of ["application/pdf", "image/jpeg", "image/png"]) {
      assert.equal(validarDocumento(mime, 1000), null, mime);
    }
  });

  it("recusa outros formatos", () => {
    assert.match(validarDocumento("application/x-msdownload", 1000) ?? "", /formato/i);
    assert.match(validarDocumento("text/html", 1000) ?? "", /formato/i);
  });

  it("recusa arquivo vazio ou grande demais", () => {
    assert.match(validarDocumento("application/pdf", 0) ?? "", /vazio/i);
    assert.match(validarDocumento("application/pdf", 9_000_000) ?? "", /muito grande/i);
  });
});
