"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { requireUser } from "@/lib/auth";
import { gerarConviteAcesso } from "@/lib/portal-auth";
import { origemDaRequisicao } from "@/lib/portal-core";
import { logAction } from "@/lib/audit";
import { waLink } from "@/lib/format";

/**
 * Gera (ou renova) o convite de acesso ao portal de um cliente.
 *
 * Acao administrativa: quem decide quem tem portal e a equipe. O token so
 * existe legivel aqui, nesta resposta — o banco guarda o SHA-256. A tela
 * recebe o link pronto para copiar/mandar pelo WhatsApp.
 *
 * O endereco do portal vem da PROPRIA REQUISICAO (host/x-forwarded-host),
 * entao o link sai completo automaticamente: se a equipe abrir o sistema pelo
 * workers.dev, o convite aponta para o workers.dev; se abrir pelo dominio
 * proprio, aponta para ele. PORTAL_BASE_URL, quando definida, tem prioridade
 * para ambientes onde o proxy esconde o host real.
 */
export async function gerarAcessoPortal(fd: FormData) {
  const user = await requireUser();
  const id = Number(fd.get("id"));
  const convite = await gerarConviteAcesso(id);
  if (!convite) redirect(`/clientes/${id}?aviso=${encodeURIComponent("Cliente não encontrado ou inativo.")}`);

  let origem = process.env.PORTAL_BASE_URL || "";
  if (!origem) {
    const h = await headers();
    origem = origemDaRequisicao(h);
  }
  const link = `${origem}/portal/primeiro-acesso?token=${convite!.token}`;

  await logAction(
    user,
    "criar",
    "cliente",
    id,
    `${user.name} gerou um convite de acesso ao portal para o cliente`,
  );
  revalidatePath(`/clientes/${id}`);
  redirect(`/clientes/${id}?portal_link=${encodeURIComponent(link)}&portal_wa=${encodeURIComponent(convite!.whatsapp ?? "")}`);
}
