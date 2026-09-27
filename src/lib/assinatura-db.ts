import "server-only";
import { all, getDb, insert, one, run } from "./db";
import { getSettings } from "./settings";
import { nowLocal, today } from "./format";
import { buildContractBodyDigital } from "./contracts";
import { bytesDaAssinatura, gerarToken, hashDocumento, impedimento, sha256, TOKEN_VALIDO, validarEntrada, type EntradaAssinatura } from "./assinatura";
import { getCompanySignature } from "./assinatura-empresa";

/**
 * Assinatura virtual: emissao do link, leitura publica e registro da assinatura.
 *
 * O contrato assinado e congelado: body_snapshot guarda o texto exato que a
 * pessoa leu, e editar o contrato depois nao alcanca esse retrato. E por isso
 * que uma correcao posterior exige um contrato novo, nunca uma sobrescrita.
 */

/** Cria o link e devolve o token em texto: e a unica vez que ele existe legivel. */
export async function gerarLink(contractId: number, userId?: number): Promise<{ token: string; id: number } | null> {
  const contrato = await one<any>(
    `SELECT c.id, c.status, c.reservation_id, r.customer_id
       FROM contracts c JOIN reservations r ON r.id = c.reservation_id WHERE c.id = ?`,
    [contractId],
  );
  if (!contrato) return null;

  const s = await getSettings();
  const dias = Math.max(0, Number(s.signature_link_days ?? 7) || 0);
  const token = gerarToken();
  const hash = await sha256(token);

  // links antigos ainda pendentes perdem a validade: so o mais recente vale
  await run(
    `UPDATE contract_signatures SET status='revogado', revoked_at=? WHERE contract_id=? AND status='pendente'`,
    [nowLocal(), contractId],
  );

  const expira = dias > 0 ? `${somarDias(today(), dias)}T23:59:59` : null;
  const id = await insert(
    `INSERT INTO contract_signatures (contract_id, customer_id, reservation_id, token_hash, expires_at, created_by)
     VALUES (?,?,?,?,?,?)`,
    [contractId, contrato.customer_id, contrato.reservation_id, hash, expira, userId ?? null],
  );
  return { token, id };
}

function somarDias(dataISO: string, dias: number): string {
  const d = new Date(`${dataISO}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Assinaturas de um contrato, para a tela administrativa. */
export async function assinaturasDoContrato(contractId: number) {
  return await all<any>(
    `SELECT * FROM contract_signatures WHERE contract_id = ? ORDER BY id DESC`,
    [contractId],
  );
}

export async function revogarLink(id: number): Promise<boolean> {
  const r = await run(
    `UPDATE contract_signatures SET status='revogado', revoked_at=? WHERE id=? AND status='pendente'`,
    [nowLocal(), id],
  );
  return !!r.meta.changes;
}

/**
 * Primeiro acesso do cliente ao link define o corpo do contrato digital.
 *
 * O corpo vindo do modelo de impressao (gerado em ensureContract) e trocado ali
 * mesmo pelo texto renderizado a partir do MODELO DIGITAL, com
 * {{data_assinatura_digital}} resolvida para a data desta abertura. De la em
 * diante o texto esta congelado: reabrir o link no dia seguinte nao muda a
 * data, e editar o modelo digital depois nao altera o que o cliente ja leu.
 *
 * A gravacao usa a mesma trava otimista da assinatura (WHERE ... AND
 * body_frozen_at IS NULL): duas aberturas simultaneas geram um congelamento so.
 * Contratos assinados em versoes antigas, sem body_frozen_at, nao sao tocados.
 */
export async function congelarCorpoAoAbrir(registro: any): Promise<any> {
  if (registro.body_frozen_at) return registro;
  if (registro.status !== "pendente") return registro;
  if (registro.expires_at && nowLocal() > registro.expires_at.slice(0, 19)) return registro;
  if (registro.contract_status === "assinado") return registro;

  const contrato = await one<any>(
    `SELECT number, reservation_id, status FROM contracts WHERE id = ?`,
    [registro.contract_id],
  );
  if (!contrato || contrato.status === "assinado") return registro;

  // fuso do negocio: a data entra no formato "Uberlândia, 12 de setembro de 2026"
  const corpoDigital = await buildContractBodyDigital(contrato.reservation_id, contrato.number);
  const agora = nowLocal();

  const marcou = await run(
    `UPDATE contracts SET body = ?, body_frozen_at = ? WHERE id = ? AND body_frozen_at IS NULL`,
    [corpoDigital, agora, registro.contract_id],
  );
  if (!marcou.meta.changes) {
    // outra abertura congelou primeiro: leia o texto que ganhou a corrida
    const existente = await one<any>(
      `SELECT body, body_frozen_at FROM contracts WHERE id = ?`,
      [registro.contract_id],
    );
    return { ...registro, body: existente?.body ?? registro.body, body_frozen_at: existente?.body_frozen_at ?? agora };
  }
  return { ...registro, body: corpoDigital, body_frozen_at: agora };
}

/**
 * Carrega o contrato pelo token da URL publica.
 *
 * A busca e pelo hash: o token nunca aparece no banco, e um token invalido nao
 * chega nem a consultar, o que evita usar o formato da URL como sonda.
 */
export async function porToken(token: string) {
  if (!TOKEN_VALIDO.test(token)) return null;
  const hash = await sha256(token);
  return await one<any>(
    `SELECT a.*, c.number AS contract_number, c.body, c.status AS contract_status, c.body_frozen_at AS body_frozen_at,
            r.number AS reservation_number, r.event_date, r.address, r.district, r.city, r.total_cents,
            cli.name AS customer_name
       FROM contract_signatures a
       JOIN contracts c ON c.id = a.contract_id
       JOIN reservations r ON r.id = c.reservation_id
       JOIN customers cli ON cli.id = a.customer_id
      WHERE a.token_hash = ?`,
    [hash],
  );
}

/**
 * Registra a assinatura.
 *
 * Toda regra critica e conferida aqui, mesmo que a tela ja tenha conferido: a
 * pagina publica e o unico ponto do sistema aberto para a internet inteira.
 * A gravacao usa uma trava otimista, entao dois cliques ao mesmo tempo geram
 * uma assinatura so, um documento so e um registro so no historico.
 */
export async function assinar(
  token: string,
  entrada: EntradaAssinatura,
  contexto: { ip?: string | null; userAgent?: string | null },
): Promise<{ erro?: string; ok?: boolean }> {
  const erroEntrada = validarEntrada(entrada);
  if (erroEntrada) return { erro: erroEntrada };

  const bytes = bytesDaAssinatura(entrada.imagem);
  if (!bytes) return { erro: "Assinatura inválida." };

  const registro = await porToken(token);
  if (!registro) return { erro: "Link inválido." };

  const bloqueio = impedimento(registro, nowLocal());
  if (bloqueio) {
    return { erro: bloqueio === "assinado" ? "Este contrato já foi assinado." : "Este link não é mais válido." };
  }

  const agora = nowLocal();
  const arquivoId = crypto.randomUUID().replace(/-/g, "");
  await getDb()
    .prepare(`INSERT INTO files (id, mime, size, data) VALUES (?,?,?,?)`)
    .bind(arquivoId, "image/png", bytes.length, bytes)
    .run();

  const nome = entrada.nome.trim();
  const hash = await hashDocumento({
    body: registro.body,
    signerName: nome,
    signedAt: agora,
    signatureRef: arquivoId,
  });

  // so grava se ainda estiver pendente: e isso que impede a assinatura dupla
  // A assinatura da empresa acompanha o documento se ja estava cadastrada no
  // momento em que o cliente assinou (veja company_signature_included).
  const temAssinaturaEmpresa = (await getCompanySignature()) !== null;
  const marcou = await run(
    `UPDATE contract_signatures
        SET status='assinado', body_snapshot=?, signer_name=?, signature_file_id=?, document_hash=?,
            accepted_at=?, signed_at=?, ip_address=?, user_agent=?, company_signature_included=?
      WHERE id=? AND status='pendente'`,
    [
      registro.body,
      nome,
      arquivoId,
      hash,
      agora,
      agora,
      (contexto.ip ?? "").slice(0, 45) || null,
      (contexto.userAgent ?? "").slice(0, 300) || null,
      temAssinaturaEmpresa ? 1 : 0,
      registro.id,
    ],
  );
  if (!marcou.meta.changes) {
    await run(`DELETE FROM files WHERE id = ?`, [arquivoId]);
    return { erro: "Este contrato já foi assinado." };
  }

  await run(
    `UPDATE contracts SET status='assinado', signed_at=?, signer_name=? WHERE id=? AND status <> 'assinado'`,
    [agora, nome, registro.contract_id],
  );

  // entra no historico documental do cliente como registro proprio, sem
  // substituir nenhum documento anterior
  await insert(
    `INSERT INTO customer_documents (customer_id, contract_id, reservation_id, signature_id, title, source, file_id, mime)
     VALUES (?,?,?,?,?,'assinatura_virtual',?, 'image/png')`,
    [
      registro.customer_id,
      registro.contract_id,
      registro.reservation_id,
      registro.id,
      `Contrato ${registro.contract_number} assinado`,
      arquivoId,
    ],
  );

  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Historico documental                                                */
/* ------------------------------------------------------------------ */

export async function documentosDoCliente(customerId: number) {
  return await all<any>(
    `SELECT d.*, c.number AS contract_number, a.signed_at, a.signer_name, a.document_hash
       FROM customer_documents d
       LEFT JOIN contracts c ON c.id = d.contract_id
       LEFT JOIN contract_signatures a ON a.id = d.signature_id
      WHERE d.customer_id = ? ORDER BY d.id DESC`,
    [customerId],
  );
}

/** Versao assinada, congelada, para leitura e impressao. */
export async function documentoAssinado(signatureId: number) {
  return await one<any>(
    `SELECT a.*, c.number AS contract_number, cli.name AS customer_name, cli.doc AS customer_doc,
            r.number AS reservation_number
       FROM contract_signatures a
       JOIN contracts c ON c.id = a.contract_id
       JOIN customers cli ON cli.id = a.customer_id
       LEFT JOIN reservations r ON r.id = a.reservation_id
      WHERE a.id = ? AND a.status = 'assinado'`,
    [signatureId],
  );
}
