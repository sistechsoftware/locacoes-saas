"use server";
/**
 * Ações da seção Loja Virtual (Configurações > Minha Loja Virtual).
 *
 * Portas: requireModuleEdit("configuracoes") (papel owner/admin + gate de
 * assinatura) E exigirRecurso(loja_virtual) (plano Empresarial ou liberação
 * administrativa). Sem as duas, nenhuma escrita acontece — esconder a tela
 * nunca é a autorização.
 */
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireModuleEdit, type CompanyContext } from "@/lib/auth";
import { exigirRecurso, temRecurso, registrarNegacao } from "@/lib/plano-gate";
import {
  aprovarPedido,
  cancelarPedido,
  criarOrcamentoDoPedido,
  definirPagamento,
  pausarLoja,
  publicarLoja,
  recusarPedido,
  salvarIdentidadeLoja,
  salvarPixLoja,
  salvarProdutoLoja,
  salvarRegrasLoja,
} from "@/lib/loja-db";
import { saveUpload } from "@/lib/uploads";

/** Porta única das actions desta seção: papel + recurso + assinatura.
 *  A entrada com gate (requireModuleEdit) fica em cada action chamadora — é
 *  obrigatória para a checagem estática do repositório e deixa a porta óbvia
 *  no próprio corpo de cada ação. */
async function exigirLoja(ctx: CompanyContext) {
  if (!(await temRecurso(ctx.user, "loja_virtual"))) {
    registrarNegacao(ctx.companyId, "loja_virtual", "action-loja");
    redirect(`/plano-restrito?recurso=loja_virtual`);
  }
  return ctx;
}

const back = (secao: string, params: Record<string, string>) =>
  redirect(`/configuracoes/loja/${secao}?${new URLSearchParams(params).toString()}`);

/* ------------------------------------------------------------------ */
/* Identidade e visual                                                 */
/* ------------------------------------------------------------------ */

export async function salvarIdentidadeAction(fd: FormData) {
  const { companyId } = await exigirLoja(await requireModuleEdit("configuracoes"));

  // Uploads: a URL nova só substitui a antiga quando o arquivo subiu.
  const logo = await saveUpload(fd.get("logo_file") as File | null);
  const banner = await saveUpload(fd.get("banner_file") as File | null);
  const seoImage = await saveUpload(fd.get("seo_image_file") as File | null);

  const faq = lerFaq(String(fd.get("faq_linhas") ?? ""));

  const dados: Record<string, unknown> = {
    display_name: String(fd.get("display_name") ?? ""),
    description: String(fd.get("description") ?? ""),
    presentation: String(fd.get("presentation") ?? ""),
    phone: String(fd.get("phone") ?? ""),
    whatsapp: String(fd.get("whatsapp") ?? ""),
    address: String(fd.get("address") ?? ""),
    city: String(fd.get("city") ?? ""),
    region: String(fd.get("region") ?? ""),
    hours: String(fd.get("hours") ?? ""),
    instagram: String(fd.get("instagram") ?? ""),
    extra_info: String(fd.get("extra_info") ?? ""),
    theme: String(fd.get("theme") ?? "padrao"),
    color_primary: String(fd.get("color_primary") ?? ""),
    color_secondary: String(fd.get("color_secondary") ?? ""),
    color_accent: String(fd.get("color_accent") ?? ""),
    color_background: String(fd.get("color_background") ?? ""),
    color_text: String(fd.get("color_text") ?? ""),
    button_style: String(fd.get("button_style") ?? "arredondado"),
    show_banner: fd.get("show_banner") ? "1" : "0",
    show_about: fd.get("show_about") ? "1" : "0",
    show_delivery: fd.get("show_delivery") ? "1" : "0",
    show_faq: fd.get("show_faq") ? "1" : "0",
    show_contact: fd.get("show_contact") ? "1" : "0",
    about_text: String(fd.get("about_text") ?? ""),
    delivery_text: String(fd.get("delivery_text") ?? ""),
    faq_json: JSON.stringify(faq),
    notice_text: String(fd.get("notice_text") ?? ""),
    seo_title: String(fd.get("seo_title") ?? ""),
    seo_description: String(fd.get("seo_description") ?? ""),
    ...(logo ? { logo_url: logo } : {}),
    ...(banner ? { banner_url: banner } : {}),
    ...(seoImage ? { seo_image_url: seoImage } : {}),
  };
  if (fd.has("slug")) dados.slug = String(fd.get("slug") ?? "");

  const r = await salvarIdentidadeLoja(companyId, dados);
  if (!r.ok) back("personalizacao", { erro: r.erro });
  revalidatePath("/loja", "layout");
  back("personalizacao", { ok: "Aparência salva." });
}

/** "Pergunta? | Resposta" por linha -> array de {q, a}. */
function lerFaq(texto: string): { q: string; a: string }[] {
  return texto
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [q, ...resto] = l.split("|");
      return { q: q.trim().slice(0, 200), a: resto.join("|").trim().slice(0, 500) };
    })
    .filter((i) => i.q && i.a)
    .slice(0, 20);
}

/* ------------------------------------------------------------------ */
/* Regras comerciais                                                   */
/* ------------------------------------------------------------------ */

export async function salvarRegrasAction(fd: FormData) {
  const { companyId } = await exigirLoja(await requireModuleEdit("configuracoes"));
  await salvarRegrasLoja(companyId, {
    mode: String(fd.get("mode") ?? "manual"),
    hide_prices: fd.get("hide_prices") ? "1" : "0",
    min_lead_days: String(fd.get("min_lead_days") ?? "0"),
    max_days_ahead: String(fd.get("max_days_ahead") ?? "0"),
    min_order_cents: String(fd.get("min_order_cents") ?? "0"),
    offer_delivery: fd.get("offer_delivery") ? "1" : "0",
    offer_pickup: fd.get("offer_pickup") ? "1" : "0",
    freight_type: String(fd.get("freight_type") ?? "locacao"),
    freight_pending_ok: fd.get("freight_pending_ok") ? "1" : "0",
    signal_percent: String(fd.get("signal_percent") ?? "0"),
    payment_deadline_h: String(fd.get("payment_deadline_h") ?? "48"),
    require_terms: fd.get("require_terms") ? "1" : "0",
    terms_text: String(fd.get("terms_text") ?? ""),
    cancellation_text: String(fd.get("cancellation_text") ?? ""),
    privacy_text: String(fd.get("privacy_text") ?? ""),
    success_message: String(fd.get("success_message") ?? ""),
  });
  revalidatePath("/loja", "layout");
  back("comercial", { ok: "Regras comerciais salvas." });
}

/* ------------------------------------------------------------------ */
/* Pix                                                                 */
/* ------------------------------------------------------------------ */

export async function salvarPixAction(fd: FormData) {
  const { companyId } = await exigirLoja(await requireModuleEdit("configuracoes"));
  await salvarPixLoja(companyId, {
    pix_enabled: fd.get("pix_enabled") ? "1" : "0",
    pix_key: String(fd.get("pix_key") ?? ""),
    pix_holder: String(fd.get("pix_holder") ?? ""),
    pix_city: String(fd.get("pix_city") ?? ""),
    pix_institution: String(fd.get("pix_institution") ?? ""),
    pix_instructions: String(fd.get("pix_instructions") ?? ""),
  });
  back("pix", { ok: "Dados Pix salvos. Só ficam visíveis na loja se a exibição estiver habilitada." });
}

/* ------------------------------------------------------------------ */
/* Produtos                                                            */
/* ------------------------------------------------------------------ */

export async function salvarProdutoAction(fd: FormData) {
  const { companyId } = await exigirLoja(await requireModuleEdit("configuracoes"));
  const productId = Number(fd.get("product_id"));
  const precoRaw = String(fd.get("public_price") ?? "").trim();
  const foto = await saveUpload(fd.get("photo_file") as File | null);
  const r = await salvarProdutoLoja(companyId, productId, {
    published: fd.get("published") ? "1" : "0",
    public_price_cents: precoRaw === "" ? "" : paraCentavos(precoRaw),
    public_name: String(fd.get("public_name") ?? ""),
    public_description: String(fd.get("public_description") ?? ""),
    featured: fd.get("featured") ? "1" : "0",
    sort_order: String(fd.get("sort_order") ?? "0"),
    max_qty: String(fd.get("max_qty") ?? ""),
    ...(foto ? { photo_url: foto } : {}),
  });
  revalidatePath("/loja", "layout");
  if (!r.ok) back("produtos", { erro: r.erro ?? "Não foi possível salvar o produto." });
  back("produtos", { ok: "Produto atualizado." });
}

/** "1.234,56" (pt-BR) ou "1234.56" (en) -> centavos inteiros. */
function paraCentavos(v: string): number {
  let limpo = v.replace(/[R$\s]/g, "");
  if (limpo.includes(",")) limpo = limpo.replace(/\./g, "").replace(",", ".");
  const n = Number(limpo);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.round(n * 100);
}

/* ------------------------------------------------------------------ */
/* Publicação                                                          */
/* ------------------------------------------------------------------ */

/** Salva o identificador público (cria a loja na primeira vez). */
export async function salvarSlugAction(fd: FormData) {
  const { companyId } = await exigirLoja(await requireModuleEdit("configuracoes"));
  const r = await salvarIdentidadeLoja(companyId, { slug: String(fd.get("slug") ?? "") });
  if (!r.ok) back("publicacao", { erro: r.erro });
  revalidatePath("/loja", "layout");
  back("publicacao", { ok: "Identificador salvo." });
}

export async function publicarAcao(fd: FormData) {
  const { companyId } = await exigirLoja(await requireModuleEdit("configuracoes"));
  const acao = String(fd.get("acao") ?? "");
  if (acao === "pausar" || acao === "retomar") {
    await pausarLoja(companyId, acao === "pausar", String(fd.get("pause_message") ?? ""));
    back("publicacao", { ok: acao === "pausar" ? "Loja pausada: nenhum novo pedido será aceito." : "Loja retomada." });
  }
  const r = await publicarLoja(companyId, acao === "publicar");
  if (!r.ok) back("publicacao", { erro: r.erro });
  revalidatePath("/loja", "layout");
  back("publicacao", { ok: acao === "publicar" ? "Loja publicada!" : "Loja retirada do ar (os dados e pedidos continuam salvos)." });
}

/* ------------------------------------------------------------------ */
/* Pedidos                                                             */
/* ------------------------------------------------------------------ */

function pedidoId(fd: FormData): number {
  return Number(fd.get("order_id")) || 0;
}

export async function aprovarPedidoAction(fd: FormData) {
  const { companyId, user } = await exigirLoja(await requireModuleEdit("configuracoes"));
  const r = await aprovarPedido(companyId, pedidoId(fd), user.id);
  revalidatePath("/loja", "layout");
  if (!r.ok) back(`pedidos/${pedidoId(fd)}`, { erro: r.erro });
  back(`pedidos/${pedidoId(fd)}`, { ok: "Solicitação aprovada." });
}

export async function recusarPedidoAction(fd: FormData) {
  const { companyId, user } = await exigirLoja(await requireModuleEdit("configuracoes"));
  const r = await recusarPedido(companyId, pedidoId(fd), user.id, String(fd.get("motivo") ?? ""));
  revalidatePath("/loja", "layout");
  if (!r.ok) back(`pedidos/${pedidoId(fd)}`, { erro: r.erro });
  back(`pedidos/${pedidoId(fd)}`, { ok: "Solicitação recusada." });
}

export async function cancelarPedidoAction(fd: FormData) {
  const { companyId, user } = await exigirLoja(await requireModuleEdit("configuracoes"));
  const r = await cancelarPedido(companyId, pedidoId(fd), user.id, String(fd.get("motivo") ?? ""));
  revalidatePath("/loja", "layout");
  if (!r.ok) back(`pedidos/${pedidoId(fd)}`, { erro: r.erro });
  back(`pedidos/${pedidoId(fd)}`, { ok: "Solicitação cancelada." });
}

export async function criarOrcamentoAction(fd: FormData) {
  const { companyId, user } = await exigirLoja(await requireModuleEdit("configuracoes"));
  const r = await criarOrcamentoDoPedido(companyId, pedidoId(fd), user.id);
  revalidatePath("/loja", "layout");
  if (!r.ok) back(`pedidos/${pedidoId(fd)}`, { erro: r.erro });
  back(`pedidos/${pedidoId(fd)}`, { ok: "Orçamento criado no módulo de Orçamentos." });
}

export async function pagamentoAcao(fd: FormData) {
  const { companyId, user } = await exigirLoja(await requireModuleEdit("configuracoes"));
  const acao = String(fd.get("pagamento") ?? "") === "confirmar" ? "confirmar" : "recusar";
  const r = await definirPagamento(companyId, pedidoId(fd), acao, user.id);
  revalidatePath("/loja", "layout");
  if (!r.ok) back(`pedidos/${pedidoId(fd)}`, { erro: r.erro });
  back(`pedidos/${pedidoId(fd)}`, {
    ok: acao === "confirmar" ? "Pagamento confirmado." : "Comprovante recusado: o pedido continua aguardando pagamento.",
  });
}
