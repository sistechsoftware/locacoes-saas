"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { one, run } from "@/lib/db";
import { assertAdmin, requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { buildContractBody, buildContractBodyDigital, ensureContract } from "@/lib/contracts";
import { getCompanySignature } from "@/lib/assinatura-empresa";
import { nowLocal, today } from "@/lib/format";
import { assinaturasDoContrato, gerarLink, revogarLink } from "@/lib/assinatura-db";

export async function generateContract(fd: FormData) {
  const user = await requireUser();
  const reservationId = Number(fd.get("reservation_id"));
  const id = await ensureContract(reservationId, user.id);
  const c = await one<any>(`SELECT number FROM contracts WHERE id = ?`, [id]);
  await logAction(user, "criar", "contrato", id, `${user.name} gerou o contrato ${c?.number}`);
  revalidatePath(`/reservas/${reservationId}`);
  redirect(`/contratos/${id}`);
}

/**
 * Regera o texto a partir do modelo atual e dos dados atuais da reserva.
 *
 * O modelo segue o uso do contrato: com link de assinatura digital em aberto,
 * o texto vem do MODELO DIGITAL — o que o cliente le no link; sem link, do
 * modelo de impressao. Assinado, nada muda: o texto congelado nunca é
 * sobrescrito (o redirect acima já bloqueia esse caminho).
 */
export async function regenerateContract(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const c = await one<any>(`SELECT * FROM contracts WHERE id = ?`, [id]);
  if (!c) return;
  if (c.status === "assinado") {
    redirect(`/contratos/${id}?erro=${encodeURIComponent("Contrato assinado não pode ser regerado.")}`);
  }
  const assinaturas = await assinaturasDoContrato(id);
  const temLinkAberto = assinaturas.some((a: any) => a.status === "pendente");
  const body = temLinkAberto
    ? await buildContractBodyDigital(c.reservation_id, c.number)
    : await buildContractBody(c.reservation_id, c.number);
  /**
   * Regerar e uma acao explicita sobre este contrato: a flag passa a refletir
   * o momento do reprocessamento (se a assinatura da empresa existe agora,
   * o bloco entra na impressao deste contrato). Contratos nao regerados nao
   * sao tocados — seus NULLs permanecem.
   */
  const temAssinaturaEmpresa = (await getCompanySignature()) !== null;
  await run(`UPDATE contracts SET body = ?, company_signature_included = ? WHERE id = ?`, [
    body,
    temAssinaturaEmpresa ? 1 : 0,
    id,
  ]);
  await logAction(user, "editar", "contrato", id, `${user.name} regerou o contrato ${c.number}`);
  revalidatePath(`/contratos/${id}`);
}

export async function setContractStatus(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const status = String(fd.get("status"));
  const signer = String(fd.get("signer_name") ?? "");
  const c = await one<any>(`SELECT * FROM contracts WHERE id = ?`, [id]);
  if (!c) return;

  await run(
    `UPDATE contracts SET status = ?, signer_name = COALESCE(NULLIF(?,''), signer_name),
            sent_at = CASE WHEN ? = 'enviado' THEN ? ELSE sent_at END,
            signed_at = CASE WHEN ? = 'assinado' THEN ? ELSE signed_at END
      WHERE id = ?`,
    [status, signer, status, today(), status, today(), id],
  );
  await logAction(user, "status", "contrato", id, `${user.name} marcou o contrato ${c.number} como ${status}`);
  revalidatePath(`/contratos/${id}`);
  revalidatePath(`/reservas/${c.reservation_id}`);
}

export async function saveContractBody(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const body = String(fd.get("body") ?? "");
  await run(`UPDATE contracts SET body = ? WHERE id = ?`, [body, id]);
  await logAction(user, "editar", "contrato", id, `${user.name} editou o texto do contrato`);
  revalidatePath(`/contratos/${id}`);
}

/* ------------------------------------------------------------------ */
/* Assinatura virtual                                                  */
/* ------------------------------------------------------------------ */

/**
 * Cria o link publico de assinatura.
 *
 * O token so existe legivel neste retorno: no banco fica o hash. Por isso ele
 * volta pela URL uma unica vez, para o operador copiar e mandar ao cliente.
 */
export async function gerarLinkAssinatura(fd: FormData) {
  const user = await requireUser();
  const contractId = Number(fd.get("id"));
  const criado = await gerarLink(contractId, user.id);
  if (!criado) redirect(`/contratos/${contractId}?erro=${encodeURIComponent("Contrato não encontrado.")}`);

  await run(`UPDATE contracts SET status='enviado', sent_at=? WHERE id=? AND status='pendente'`, [
    nowLocal(),
    contractId,
  ]);
  await logAction(user, "editar", "contrato", contractId, `${user.name} gerou o link de assinatura do contrato`);
  revalidatePath(`/contratos/${contractId}`);
  redirect(`/contratos/${contractId}?token=${criado.token}`);
}

export async function revogarLinkAssinatura(fd: FormData) {
  const user = await requireUser();
  const contractId = Number(fd.get("contract_id"));
  const id = Number(fd.get("id"));
  if (await revogarLink(id)) {
    await logAction(user, "editar", "contrato", contractId, `${user.name} revogou o link de assinatura`);
  }
  revalidatePath(`/contratos/${contractId}`);
}
