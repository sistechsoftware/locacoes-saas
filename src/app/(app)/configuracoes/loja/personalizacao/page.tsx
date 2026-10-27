import { requireModule } from "@/lib/auth";
import { temRecurso, bloquearRecurso, registrarNegacao } from "@/lib/plano-gate";
import { lojaDaEmpresa } from "@/lib/loja-db";
import { PageHeader, Alerta } from "@/components/ui";
import PersonalizacaoForm, { type IdentidadeInicial } from "../PersonalizacaoForm";

export const dynamic = "force-dynamic";

function linhasFaq(json: string): string {
  try {
    const arr = JSON.parse(json || "[]");
    if (!Array.isArray(arr)) return "";
    return arr.map((i: any) => `${i.q} | ${i.a}`).join("\n");
  } catch {
    return "";
  }
}

export default async function PersonalizacaoPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string; ok?: string }>;
}) {
  const ctx = await requireModule("configuracoes");
  if (!(await temRecurso(ctx.user, "loja_virtual"))) {
    registrarNegacao(ctx.companyId, "loja_virtual", "pagina-loja");
    bloquearRecurso("loja_virtual", ctx.user, "pagina");
  }
  const { erro, ok } = await searchParams;
  const loja = await lojaDaEmpresa(ctx.companyId);

  const inicial: IdentidadeInicial = {
    display_name: loja?.display_name ?? "",
    logo_url: loja?.logo_url ?? null,
    banner_url: loja?.banner_url ?? null,
    description: loja?.description ?? "",
    presentation: loja?.presentation ?? "",
    phone: loja?.phone ?? "",
    whatsapp: loja?.whatsapp ?? "",
    address: loja?.address ?? "",
    city: loja?.city ?? "",
    region: loja?.region ?? "",
    hours: loja?.hours ?? "",
    instagram: loja?.instagram ?? "",
    extra_info: loja?.extra_info ?? "",
    theme: loja?.theme || "padrao",
    color_primary: loja?.color_primary ?? "",
    color_secondary: loja?.color_secondary ?? "",
    color_accent: loja?.color_accent ?? "",
    color_background: loja?.color_background ?? "",
    color_text: loja?.color_text ?? "",
    button_style: loja?.button_style ?? "arredondado",
    show_banner: loja?.show_banner ?? 1,
    show_about: loja?.show_about ?? 1,
    show_delivery: loja?.show_delivery ?? 1,
    show_faq: loja?.show_faq ?? 1,
    show_contact: loja?.show_contact ?? 1,
    about_text: loja?.about_text ?? "",
    delivery_text: loja?.delivery_text ?? "",
    faq_linhas: linhasFaq(loja?.faq_json ?? "[]"),
    notice_text: loja?.notice_text ?? "",
    seo_title: loja?.seo_title ?? "",
    seo_description: loja?.seo_description ?? "",
    seo_image_url: loja?.seo_image_url ?? null,
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Personalização"
        subtitle="Identidade, cores e seções da sua loja. Estas cores valem só na loja — o painel continua com o tema do Locô."
      />
      {!loja && (
        <Alerta tone="ambar" title="Loja ainda não criada">
          Defina primeiro o endereço público em{" "}
          <a href="/configuracoes/loja/publicacao" className="font-semibold underline">
            Publicação
          </a>
          .
        </Alerta>
      )}
      <PersonalizacaoForm inicial={inicial} erro={erro} ok={ok} />
    </div>
  );
}
