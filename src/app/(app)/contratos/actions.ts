"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { one, run } from "@/lib/db";
import { assertAdmin, requireModuleEdit } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import {
  buildContractBody,
  buildContractBodyDigital,
  ensureContract,
  substituirContrato as substituirContratoDb,
} from "@/lib/contracts";
import { getCompanySignature } from "@/lib/assinatura-empresa";
import { nowLocal, today } from "@/lib/format";
import { assinaturasDoContrato, gerarLink, revogarLink } from "@/lib/assinatura-db";

export async function generateContract(fd: FormData) {
  const { user, companyId } = await requireModuleEdit("contratos");
  const reservationId = Number(fd.get("reservation_id"));
  // Isolamento: contrato só nasce sobre reserva da própria empresa.
  if (!await one(`SELECT id FROM reservations WHERE id = ? AND company_id = ?`, [reservationId, companyId])) {
    redirect("/reservas");
  }
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
  const { user, companyId } = await requireModuleEdit("contratos");
  const id = Number(fd.get("id"));
  const c = await one<any>(`SELECT * FROM contracts WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!c) return;
  if (c.status === "assinado") {
    redirect(`/contratos/${id}?erro=${encodeURIComponent("Contrato assinado não pode ser regerado.")}`);
  }
  if (c.status === "cancelado" || c.superseded_by_id) {
    redirect(
      `/contratos/${id}?erro=${encodeURIComponent("Contrato substituído ou cancelado não pode ser regerado.")}`,
    );
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
  await run(`UPDATE contracts SET body = ?, company_signature_included = ? WHERE id = ? AND company_id = ?`, [
    body,
    temAssinaturaEmpresa ? 1 : 0,
    id,
    companyId,
  ]);
  await logAction(user, "editar", "contrato", id, `${user.name} regerou o contrato ${c.number}`);
  revalidatePath(`/contratos/${id}`);
}

export async function setContractStatus(fd: FormData) {
  const { user, companyId } = await requireModuleEdit("contratos");
  const id = Number(fd.get("id"));
  const status = String(fd.get("status"));
  const signer = String(fd.get("signer_name") ?? "");
  const c = await one<any>(`SELECT * FROM contracts WHERE id = ? AND company_id = ?`, [id, companyId]);
  if (!c) return;
  // documento revogado e prova historica: status nao pode ser reaberto
  if (c.status === "cancelado" || c.superseded_by_id) {
    redirect(
      `/contratos/${id}?erro=${encodeURIComponent("Contrato substituído ou cancelado não pode ter o status alterado.")}`,
    );
  }

  await run(
    `UPDATE contracts SET status = ?, signer_name = COALESCE(NULLIF(?,''), signer_name),
            sent_at = CASE WHEN ? = 'enviado' THEN ? ELSE sent_at END,
            signed_at = CASE WHEN ? = 'assinado' THEN ? ELSE signed_at END
      WHERE id = ? AND company_id = ?`,
    [status, signer, status, today(), status, today(), id, companyId],
  );
  await logAction(user, "status", "contrato", id, `${user.name} marcou o contrato ${c.number} como ${status}`);
  revalidatePath(`/contratos/${id}`);
  revalidatePath(`/reservas/${c.reservation_id}`);
}

export async function saveContractBody(fd: FormData) {
  const user = await assertAdmin();
  const id = Number(fd.get("id"));
  const c = await one<any>(`SELECT status, superseded_by_id FROM contracts WHERE id = ? AND company_id = ?`, [
    id,
    user.company_id,
  ]);
  if (!c) return;
  // o texto aceito esta congelado em body_snapshot; editar o corpo de um
  // contrato assinado so criaria divergencia entre a tela e a via assinada
  if (c.status === "assinado" || c.status === "cancelado" || c.superseded_by_id) {
    redirect(
      `/contratos/${id}?erro=${encodeURIComponent("Contrato assinado ou substituído não pode ser editado. Gere um novo contrato.")}`,
    );
  }
  const body = String(fd.get("body") ?? "");
  await run(`UPDATE contracts SET body = ? WHERE id = ? AND company_id = ?`, [body, id, user.company_id]);
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
  const { user, companyId } = await requireModuleEdit("contratos");
  const contractId = Number(fd.get("id"));
  // O contrato precisa pertencer à empresa do usuário antes de gerar link.
  const contrato = await one<any>(
    `SELECT status, superseded_by_id FROM contracts WHERE id = ? AND company_id = ?`,
    [contractId, companyId],
  );
  if (!contrato) redirect("/contratos");
  // assinado ja tem via; cancelado/substituido nao pode voltar a circular
  if (contrato.status === "assinado" || contrato.status === "cancelado" || contrato.superseded_by_id) {
    redirect(
      `/contratos/${contractId}?erro=${encodeURIComponent("Contrato assinado ou substituído não gera novo link.")}`,
    );
  }
  const criado = await gerarLink(contractId, user.id);
  if (!criado) redirect(`/contratos/${contractId}?erro=${encodeURIComponent("Contrato não encontrado.")}`);

  await run(`UPDATE contracts SET status='enviado', sent_at=? WHERE id=? AND status='pendente' AND company_id=?`, [
    nowLocal(),
    contractId,
    companyId,
  ]);
  await logAction(user, "editar", "contrato", contractId, `${user.name} gerou o link de assinatura do contrato`);
  revalidatePath(`/contratos/${contractId}`);
  redirect(`/contratos/${contractId}?token=${criado.token}`);
}

/**
 * Substitui o contrato vigente por um novo, com os dados cadastrais atuais.
 *
 * O anterior e revogado (cancelado + linhagem) e a assinatura dele fica
 * arquivada; a reserva e o financeiro nao sao tocados. O operador cai no
 * contrato novo, de onde gera o link para a cliente assinar de novo.
 */
export async function substituirContrato(fd: FormData) {
  const { user, companyId } = await requireModuleEdit("contratos");
  const id = Number(fd.get("id"));
  const motivo = String(fd.get("motivo") ?? "");

  const r = await substituirContratoDb(id, companyId, user, motivo);
  if (!r.ok) {
    redirect(`/contratos/${id}?erro=${encodeURIComponent(r.erro)}`);
  }

  await logAction(
    user,
    "editar",
    "contrato",
    r.novoId,
    `${user.name} substituiu o contrato ${r.anterior} pelo ${r.numero} (${motivo.trim().slice(0, 300)})`,
    { substituido: id, substituido_numero: r.anterior, motivo: motivo.trim().slice(0, 300) },
  );
  revalidatePath(`/contratos/${id}`);
  revalidatePath(`/contratos/${r.novoId}`);
  revalidatePath("/contratos");
  revalidatePath(`/reservas/${Number(fd.get("reservation_id"))}`);
  redirect(`/contratos/${r.novoId}`);
}

export async function revogarLinkAssinatura(fd: FormData) {
  const { user, companyId } = await requireModuleEdit("contratos");
  const contractId = Number(fd.get("contract_id"));
  const id = Number(fd.get("id"));
  // Só revoga se o contrato é da empresa do usuário.
  const meu = await one(`SELECT id FROM contracts WHERE id = ? AND company_id = ?`, [contractId, companyId]);
  if (meu && (await revogarLink(id))) {
    await logAction(user, "editar", "contrato", contractId, `${user.name} revogou o link de assinatura`);
  }
  revalidatePath(`/contratos/${contractId}`);
}
