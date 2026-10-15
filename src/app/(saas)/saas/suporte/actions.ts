"use server";

import { redirect } from "next/navigation";
import { assertPlatformAdmin } from "@/lib/auth";
import { definirStatusPlataforma, responderChamado } from "@/lib/suporte";

function msgErro(e: unknown): string {
  return e instanceof Error && e.message ? e.message : "Não foi possível concluir. Tente novamente.";
}

function arquivoDe(fd: FormData): File | null {
  const a = fd.get("arquivo");
  return a instanceof File && a.size > 0 ? a : null;
}

/** Resposta da equipe da plataforma (assertPlatformAdmin = guard do /saas). */
export async function responderSuportePlataformaAction(fd: FormData) {
  const user = await assertPlatformAdmin();
  const id = Number(fd.get("chamado"));
  let destino = `/saas/suporte/${id}`;
  try {
    if (!id) throw new Error("Chamado não encontrado.");
    await responderChamado(user, {
      ticketId: id,
      lado: "suporte",
      texto: fd.get("texto"),
      arquivo: arquivoDe(fd),
    });
  } catch (e) {
    destino = `/saas/suporte/${id}?erro=${encodeURIComponent(msgErro(e))}`;
  }
  redirect(destino);
}

/** Move o status do chamado (aberto/em_andamento/aguardando_empresa/resolvido). */
export async function definirStatusSuporteAction(fd: FormData) {
  const user = await assertPlatformAdmin();
  const id = Number(fd.get("chamado"));
  const novo = String(fd.get("status") ?? "");
  let destino = `/saas/suporte/${id}`;
  try {
    if (!id) throw new Error("Chamado não encontrado.");
    await definirStatusPlataforma(user, id, novo);
  } catch (e) {
    destino = `/saas/suporte/${id}?erro=${encodeURIComponent(msgErro(e))}`;
  }
  redirect(destino);
}
