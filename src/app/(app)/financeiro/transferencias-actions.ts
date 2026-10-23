"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertAdmin, requireModuleEdit } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { money, parseMoney, today, valorValido } from "@/lib/format";
import {
  criarTransferencia,
  editarTransferencia,
  excluirTransferencia,
  transferenciaDoGrupo,
} from "@/lib/transferencias";

/**
 * Actions de Transferência entre contas — espelho da origem
 * (financeiro/transferencias-actions.ts da Lima's), com as adaptações do SaaS:
 *
 *  * o company_id vem SEMPRE do contexto autenticado (requireModuleEdit /
 *    assertAdmin), nunca do formulário;
 *  * criar/editar exigem escrita no módulo financeiro (owner/admin/financeiro);
 *    excluir é destructivo e fica restrito a admin/owner (isDestructive);
 *  * o token de idempotência (grupo) é validado contra o company_id da sessão
 *    antes de tocar em banco.
 */

/** Volta para a aba de transferencias mantendo o periodo em vista. */
function destino(fd: FormData, extra: Record<string, string>): string {
  const params = new URLSearchParams({ aba: "transferencias" });
  const de = String(fd.get("de") ?? "");
  const ate = String(fd.get("ate") ?? "");
  if (de) params.set("de", de);
  if (ate) params.set("ate", ate);
  for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
  return `/financeiro?${params}`;
}

type Campos = {
  origemId: number;
  destinoId: number;
  valorCents: number;
  data: string;
  observacao: string;
  bruto: string;
  grupo: string;
};

function lerCampos(fd: FormData): Campos {
  return {
    origemId: Number(fd.get("origem_id")) || 0,
    destinoId: Number(fd.get("destino_id")) || 0,
    valorCents: parseMoney(String(fd.get("amount") ?? "")),
    data: String(fd.get("date") ?? "") || today(),
    observacao: String(fd.get("observacao") ?? "").trim(),
    bruto: String(fd.get("amount") ?? ""),
    grupo: String(fd.get("grupo") ?? "").trim(),
  };
}

/**
 * Executa a transferencia e comunica o resultado.
 *
 * Mesma disciplina da origem: nenhum caminho termina em silencio. Ou grava e
 * confirma, ou diz exatamente o que recusou — conta repetida, valor ilegivel,
 * valor zero ou negativo. Reenvio do mesmo formulário (token repetido) é
 * reconhecido pelo servidor e confirmado sem lançar nada de novo.
 */
export async function transferirValor(fd: FormData) {
  const { user } = await requireModuleEdit("financeiro");
  const c = lerCampos(fd);

  if (!valorValido(c.bruto)) {
    redirect(destino(fd, { erro: `Não consegui ler o valor "${c.bruto.trim()}". Use por exemplo 500,00 ou 1.234,56.` }));
  }

  const r = await criarTransferencia({
    origemId: c.origemId,
    destinoId: c.destinoId,
    valorCents: c.valorCents,
    data: c.data,
    observacao: c.observacao,
    userId: user.id,
    companyId: user.company_id,
    grupo: c.grupo,
  });
  if ("erro" in r) redirect(destino(fd, { erro: r.erro }));

  if (!r.duplicado) {
    await logAction(
      user,
      "criar",
      "transferencia",
      r.id,
      `${user.name} transferiu ${money(c.valorCents)} entre contas`,
      { transfer_group: r.grupo, origem_id: c.origemId, destino_id: c.destinoId, valor_cents: c.valorCents, data: c.data },
    );
  }
  revalidatePath("/financeiro");
  revalidatePath("/configuracoes");

  redirect(
    destino(fd, {
      ok: r.duplicado
        ? "Este envio já havia sido registrado: a transferência está lançada uma única vez."
        : `Transferência de ${money(c.valorCents)} realizada. Ela não é receita nem despesa: apenas move dinheiro entre as contas.`,
    }),
  );
}

/** Salva a edicao dos dois lados do evento de uma vez. */
export async function editarTransferenciaAction(fd: FormData) {
  const { user } = await requireModuleEdit("financeiro");
  const c = lerCampos(fd);

  if (!valorValido(c.bruto)) {
    redirect(destino(fd, { erro: `Não consegui ler o valor "${c.bruto.trim()}". Use por exemplo 500,00 ou 1.234,56.` }));
  }

  const atual = await transferenciaDoGrupo(c.grupo, user.company_id);
  if (!atual) redirect(destino(fd, { erro: "Transferência não encontrada." }));

  const r = await editarTransferencia(c.grupo, {
    origemId: c.origemId,
    destinoId: c.destinoId,
    valorCents: c.valorCents,
    data: c.data,
    observacao: c.observacao,
    userId: user.id,
    companyId: user.company_id,
    grupo: c.grupo,
  });
  if ("erro" in r) redirect(destino(fd, { erro: r.erro }));

  await logAction(
    user,
    "editar",
    "transferencia",
    null,
    `${user.name} editou a transferência de ${money(atual.valor_cents)} para ${money(c.valorCents)}`,
    { transfer_group: c.grupo, origem_id: c.origemId, destino_id: c.destinoId, valor_cents: c.valorCents, data: c.data },
  );
  revalidatePath("/financeiro");
  revalidatePath("/configuracoes");
  redirect(destino(fd, { ok: `Transferência atualizada para ${money(c.valorCents)}. Os dois lados foram ajustados juntos.` }));
}

/** Remove os dois lados de uma vez: o saldo das duas contas volta ao anterior. */
export async function excluirTransferenciaAction(fd: FormData) {
  // destructivo (apaga lançamentos): dono ou admin da empresa, nunca o papel
  // financeiro — mesma política de isDestructive do SaaS.
  const user = await assertAdmin();
  const c = lerCampos(fd);

  const atual = await transferenciaDoGrupo(c.grupo, user.company_id);
  if (!atual) redirect(destino(fd, { erro: "Transferência não encontrada." }));

  const r = await excluirTransferencia(c.grupo, user.company_id);
  if ("erro" in r) redirect(destino(fd, { erro: r.erro }));

  await logAction(
    user,
    "excluir",
    "transferencia",
    null,
    `${user.name} excluiu a transferência de ${money(atual.valor_cents)}`,
    { transfer_group: c.grupo },
  );
  revalidatePath("/financeiro");
  revalidatePath("/configuracoes");
  redirect(destino(fd, { ok: `Transferência de ${money(atual.valor_cents)} excluída. Os saldos das duas contas voltaram ao valor anterior.` }));
}
