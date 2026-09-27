"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { assertAdmin, requireUser } from "@/lib/auth";
import { logAction } from "@/lib/audit";
import { emitirQuitacao, emitirQuitacaoSeQuitada, emitirRecibo, excluirRecibo } from "@/lib/recibos";

/**
 * Actions dos recibos.
 *
 * Toda a escrita fica isolada aqui e so toca na tabela receipts. Os
 * lancamentos financeiros (payments, financial_entries, deposits) nao sao
 * lidos para alterar: sao lidos apenas para MONTAR o recibo. Um erro em
 * qualquer ponto abaixo nunca perde, altera ou duplica o lancamento original,
 * que ja esta gravado antes de qualquer chamada chegar aqui.
 */

/**
 * So aceita caminhos internos como destino de volta: o campo vem do formulario
 * e nunca pode virar um redirect para fora do sistema.
 */
function destinoSeguro(bruto: string, fallback: string): string {
  return bruto.startsWith("/") ? bruto : fallback;
}

/**
 * Gera o recibo de um pagamento e abre a pagina dele.
 *
 * Idempotente: se o pagamento ja tem recibo, apenas redireciona para ele.
 * Em caso de erro, volta para a tela de origem com a mensagem, sem tocar em
 * nada — e o usuario pode tentar de novo quantas vezes quiser.
 *
 * Quitação unificada: após o recibo individual, avalia se a locação da
 * reserva chegou ao saldo zero; chegou, emite também o recibo de quitação
 * (único por obrigação, idempotente). O redirect segue para o recibo
 * individual, como sempre — a quitação aparece como documento adicional na
 * reserva e na lista de recibos. Um erro na quitação não derruba a emissão
 * individual: volta como aviso no destino.
 */
export async function gerarReciboPayment(fd: FormData) {
  const user = await requireUser();
  const paymentId = Number(fd.get("payment_id"));
  const voltarPara = destinoSeguro(String(fd.get("voltar") ?? ""), "/financeiro?aba=receber");

  const { erro, receiptId } = await emitirRecibo(
    { tipo: "payment", paymentId },
    { userId: user.id, userName: user.name },
  );
  if (!erro && receiptId) {
    await logAction(user, "gerar", "recibo", receiptId, `${user.name} gerou o recibo do pagamento #${paymentId}`);

    const q = await emitirQuitacaoSeQuitada({ tipo: "payment", paymentId }, { userId: user.id, userName: user.name });
    if (!q.erro && q.receiptId) {
      await logAction(user, "gerar", "recibo", q.receiptId, `${user.name} gerou o recibo de quitação da locação (reserva) — pagamento #${paymentId}`);
    }
    revalidatePath("/reservas");
    // quitação criada agora? abre ela (caso do pagamento único que quita a
    // reserva); senão, segue para o recibo individual, como sempre
    const destino = q.criado && q.receiptId ? `/recibos/${q.receiptId}` : `/recibos/${receiptId}`;
    redirect(q.erro ? `${destino}?aviso=${encodeURIComponent(q.erro)}` : destino);
  }
  redirect(`${voltarPara}${voltarPara.includes("?") ? "&" : "?"}erro=${encodeURIComponent(erro ?? "Erro ao gerar o recibo.")}`);
}

/**
 * Gera o recibo de uma caucao recebida e abre a pagina dele.
 * O recibo da caucao identifica expressamente que se trata de caucao.
 *
 * Quitação unificada: mesmo gatilho do pagamento — se a caução da reserva
 * ficou integralmente em caixa, emite o recibo de quitação adicional dela.
 */
export async function gerarReciboDeposit(fd: FormData) {
  const user = await requireUser();
  const depositId = Number(fd.get("deposit_id"));
  const voltarPara = destinoSeguro(String(fd.get("voltar") ?? ""), "/financeiro");

  const { erro, receiptId } = await emitirRecibo(
    { tipo: "deposit", depositId },
    { userId: user.id, userName: user.name },
  );
  if (!erro && receiptId) {
    await logAction(user, "gerar", "recibo", receiptId, `${user.name} gerou o recibo da caução #${depositId}`);

    const q = await emitirQuitacaoSeQuitada({ tipo: "deposit", depositId }, { userId: user.id, userName: user.name });
    if (!q.erro && q.receiptId) {
      await logAction(user, "gerar", "recibo", q.receiptId, `${user.name} gerou o recibo de quitação da caução — cauções da reserva quitadas`);
    }
    revalidatePath("/reservas");
    // quitação criada agora? abre ela (caso do pagamento único que quita a
    // reserva); senão, segue para o recibo individual, como sempre
    const destino = q.criado && q.receiptId ? `/recibos/${q.receiptId}` : `/recibos/${receiptId}`;
    redirect(q.erro ? `${destino}?aviso=${encodeURIComponent(q.erro)}` : destino);
  }
  redirect(`${voltarPara}${voltarPara.includes("?") ? "&" : "?"}erro=${encodeURIComponent(erro ?? "Erro ao gerar o recibo.")}`);
}

/**
 * Exclui somente o recibo (nunca o lancamento) para permitir reemissao limpa.
 * Somente o administrador pode, no mesmo padrao das demais exclusoes.
 */
export async function excluirReciboAction(fd: FormData) {
  const user = await assertAdmin();
  const receiptId = Number(fd.get("receipt_id"));
  const voltarPara = destinoSeguro(String(fd.get("voltar") ?? ""), "/financeiro");

  const apagou = await excluirRecibo(receiptId);
  if (apagou) {
    await logAction(user, "excluir", "recibo", receiptId, `${user.name} excluiu o recibo ${receiptId} (o lançamento original foi preservado)`);
  }
  revalidatePath("/reservas");
  redirect(voltarPara);
}

/**
 * Emite o recibo de quitação da locação de uma reserva a partir da própria
 * tela dela. Reusa emitirQuitacao: idempotente, única por obrigação e só
 * quando o saldo chegou a zero. Abrir a reserva nunca gera documento — só
 * este botão (ou um recebimento novo) pode.
 */
export async function gerarQuitacaoLocacao(fd: FormData) {
  const user = await requireUser();
  const reservationId = Number(fd.get("reservation_id"));

  const { erro, receiptId } = await emitirQuitacao("locacao", reservationId, {
    userId: user.id,
    userName: user.name,
  });
  revalidatePath(`/reservas/${reservationId}`);
  if (!erro && receiptId) {
    await logAction(user, "gerar", "recibo", receiptId, `${user.name} gerou o recibo de quitação da locação da reserva #${reservationId}`);
    redirect(`/recibos/${receiptId}`);
  }
  redirect(`/reservas/${reservationId}?aviso=${encodeURIComponent(erro ?? "Não foi possível emitir a quitação — a reserva ainda tem saldo ou já tem quitação.")}`);
}

/** Emite a quitação da caução da reserva, com o mesmo padrão da da locação. */
export async function gerarQuitacaoCaucao(fd: FormData) {
  const user = await requireUser();
  const reservationId = Number(fd.get("reservation_id"));

  const { erro, receiptId } = await emitirQuitacao("caucao", reservationId, {
    userId: user.id,
    userName: user.name,
  });
  revalidatePath(`/reservas/${reservationId}`);
  if (!erro && receiptId) {
    await logAction(user, "gerar", "recibo", receiptId, `${user.name} gerou o recibo de quitação da caução da reserva #${reservationId}`);
    redirect(`/recibos/${receiptId}`);
  }
  redirect(`/reservas/${reservationId}?aviso=${encodeURIComponent(erro ?? "Não foi possível emitir a quitação — a caução ainda não está integralmente recebida ou já tem quitação.")}`);
}
