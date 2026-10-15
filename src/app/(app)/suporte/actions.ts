"use server";

import { redirect } from "next/navigation";
import { requireModuleEdit } from "@/lib/auth";
import { abrirChamado, responderChamado, fecharChamado, reabrirChamado } from "@/lib/suporte";

/** Mensagem de erro amigável para a URL (mesmo padrão das outras actions). */
function msgErro(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Não foi possível concluir. Tente novamente.";
}

function arquivoDe(fd: FormData): File | null {
  const a = fd.get("arquivo");
  return a instanceof File && a.size > 0 ? a : null;
}

/**
 * Abre um chamado no escopo da SESSÃO (requireModuleEdit aplica papel +
 * gate de assinatura; o suporte é fundamental, sem gate de plano).
 * Erro de validação volta para a própria tela com ?erro= — nada é gravado.
 */
export async function abrirChamadoAction(fd: FormData) {
  const { user } = await requireModuleEdit("suporte");
  let destino = "";
  try {
    const id = await abrirChamado(user, {
      categoria: fd.get("categoria"),
      assunto: fd.get("assunto"),
      descricao: fd.get("descricao"),
      arquivo: arquivoDe(fd),
    });
    destino = `/suporte/${id}`;
  } catch (e) {
    const assunto = String(fd.get("assunto") ?? "").slice(0, 140);
    const descricao = String(fd.get("descricao") ?? "").slice(0, 4000);
    destino = `/suporte/novo?erro=${encodeURIComponent(msgErro(e))}&assunto=${encodeURIComponent(assunto)}&descricao=${encodeURIComponent(descricao)}`;
  }
  redirect(destino);
}

/** Responde o próprio chamado (escopo conferido dentro de responderChamado). */
export async function responderChamadoEmpresaAction(fd: FormData) {
  const { user } = await requireModuleEdit("suporte");
  const id = Number(fd.get("chamado"));
  let destino = `/suporte/${id}`;
  try {
    if (!id) throw new Error("Chamado não encontrado.");
    await responderChamado(user, {
      ticketId: id,
      lado: "empresa",
      texto: fd.get("texto"),
      arquivo: arquivoDe(fd),
    });
  } catch (e) {
    destino = `/suporte/${id}?erro=${encodeURIComponent(msgErro(e))}`;
  }
  redirect(destino);
}

/** Empresa fecha o próprio chamado. */
export async function fecharChamadoAction(fd: FormData) {
  const { user } = await requireModuleEdit("suporte");
  const id = Number(fd.get("chamado"));
  if (!id) redirect("/suporte");
  try {
    await fecharChamado(user, id);
  } catch (e) {
    redirect(`/suporte/${id}?erro=${encodeURIComponent(msgErro(e))}`);
  }
  redirect(`/suporte/${id}`);
}

/** Empresa reabre o próprio chamado. */
export async function reabrirChamadoAction(fd: FormData) {
  const { user } = await requireModuleEdit("suporte");
  const id = Number(fd.get("chamado"));
  if (!id) redirect("/suporte");
  try {
    await reabrirChamado(user, id);
  } catch (e) {
    redirect(`/suporte/${id}?erro=${encodeURIComponent(msgErro(e))}`);
  }
  redirect(`/suporte/${id}`);
}
