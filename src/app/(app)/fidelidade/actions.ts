"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { run } from "@/lib/db";
import { assertAdmin, requireModuleEdit } from "@/lib/auth";
import { nowLocal } from "@/lib/format";
import { logAction } from "@/lib/audit";
import { importarHistorico } from "@/lib/fidelidade-db";

/** Marca a mensagem como enviada ou dispensada, para sair da fila. */
export async function marcarMensagem(fd: FormData) {
  const ctx = await requireModuleEdit("fidelidade");
  const id = Number(fd.get("id"));
  const status = String(fd.get("status"));
  if (status !== "enviada" && status !== "dispensada") return;
  /* Isolamento: o escopo vem do DONO da mensagem (customers.company_id) E da
     propria coluna company_id, ja que a migration 0033 backfilla a coluna pelo
     dono e os INSERTs (pendência #04) gravam o company_id do cliente. Duas
     travas para o mesmo resultado: mensagem de outro tenant nunca é alterada. */
  await run(
    `UPDATE fidelity_messages SET status=?, sent_at=?
      WHERE id=? AND company_id=? AND status='pendente'
        AND customer_id IN (SELECT id FROM customers WHERE company_id = ?)`,
    [status, status === "enviada" ? nowLocal() : null, id, ctx.companyId, ctx.companyId],
  );
  revalidatePath("/fidelidade");
}

/**
 * Traz o historico ja concluido para dentro do programa.
 *
 * E acao de administrador porque concede beneficio que vale dinheiro: um
 * cliente com doze festas passadas ganha duas recompensas na hora. A tela
 * mostra a previa antes, e a importacao nao dispara aviso nenhum, para o
 * programa nao estrear mandando mensagem para a base inteira de uma vez.
 */
export async function importarHistoricoFidelidade(fd: FormData) {
  const user = await assertAdmin();
  const resumo = await importarHistorico({ userId: user.id });
  if (resumo.locacoes > 0) {
    await logAction(
      user,
      "editar",
      "configuracao",
      null,
      `${user.name} importou ${resumo.locacoes} locacao(oes) do historico para a fidelidade, gerando ${resumo.recompensas} recompensa(s)`,
    );
  }
  revalidatePath("/fidelidade");
  revalidatePath("/clientes");
  redirect(`/fidelidade?importado=${resumo.locacoes}&recompensas=${resumo.recompensas}`);
}
