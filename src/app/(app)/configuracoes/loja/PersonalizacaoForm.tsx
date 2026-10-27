"use client";
import { useMemo, useState } from "react";
import { PALETAS_LOJA, cssDaLoja, type CoresLoja } from "@/lib/loja";
import { Field, Grid, Section, Alerta, BTN } from "@/components/ui";
import ImageInput from "@/components/ImageInput";
import { salvarIdentidadeAction } from "./actions";

export type IdentidadeInicial = {
  display_name: string;
  logo_url: string | null;
  banner_url: string | null;
  description: string;
  presentation: string;
  phone: string;
  whatsapp: string;
  address: string;
  city: string;
  region: string;
  hours: string;
  instagram: string;
  extra_info: string;
  theme: string;
  color_primary: string;
  color_secondary: string;
  color_accent: string;
  color_background: string;
  color_text: string;
  button_style: string;
  show_banner: number;
  show_about: number;
  show_delivery: number;
  show_faq: number;
  show_contact: number;
  about_text: string;
  delivery_text: string;
  faq_linhas: string;
  notice_text: string;
  seo_title: string;
  seo_description: string;
  seo_image_url: string | null;
};

/**
 * Formulário de identidade + pré-visualização ao vivo. As cores escolhidas
 * alimentam um mini-carto da loja com o MESMO css que a página pública usa
 * (cssDaLoja), então o que se vê aqui é o que sai publicado — inclusive a
 * validação de contraste, que roda no servidor antes de salvar.
 */
export default function PersonalizacaoForm({ inicial, erro, ok }: { inicial: IdentidadeInicial; erro?: string; ok?: string }) {
  const [cores, setCores] = useState<CoresLoja>({
    primary: inicial.color_primary,
    secondary: inicial.color_secondary,
    accent: inicial.color_accent,
    background: inicial.color_background,
    text: inicial.color_text,
  });
  const [nome, setNome] = useState(inicial.display_name);
  const [botao, setBotao] = useState<"arredondado" | "quadrado">(
    inicial.button_style === "quadrado" ? "quadrado" : "arredondado",
  );
  const [paleta, setPaleta] = useState(inicial.theme);

  const css = useMemo(() => cssDaLoja(cores, botao), [cores, botao]);

  function aplicarPaleta(id: string) {
    setPaleta(id);
    const p = PALETAS_LOJA.find((x) => x.id === id);
    if (p) setCores(p.cores);
  }

  return (
    <form action={salvarIdentidadeAction} className="space-y-4">
      {erro && <Alerta tone="vermelho">{erro}</Alerta>}
      {ok && <Alerta tone="verde">{ok}</Alerta>}

      <Section title="Identidade da empresa">
        <Grid>
          <Field label="Nome exibido na loja" hint="O nome comercial que o cliente vê no topo da página.">
            <input name="display_name" defaultValue={inicial.display_name} className="campo" maxLength={80} required onChange={(e) => setNome(e.target.value)} />
          </Field>
          <Field label="Telefone comercial">
            <input name="phone" defaultValue={inicial.phone} className="campo" maxLength={40} />
          </Field>
          <Field label="WhatsApp (com DDI/DDD)" hint="Ex.: 5511999998888 — vira botão de contato na loja.">
            <input name="whatsapp" defaultValue={inicial.whatsapp} className="campo" maxLength={40} />
          </Field>
          <Field label="Instagram">
            <input name="instagram" defaultValue={inicial.instagram} className="campo" placeholder="@sualoja" maxLength={120} />
          </Field>
          <Field label="Endereço comercial">
            <input name="address" defaultValue={inicial.address} className="campo" maxLength={200} />
          </Field>
          <Field label="Cidade">
            <input name="city" defaultValue={inicial.city} className="campo" maxLength={80} />
          </Field>
          <Field label="Região de atendimento">
            <input name="region" defaultValue={inicial.region} className="campo" placeholder="Ex.: São Paulo e região" maxLength={80} />
          </Field>
          <Field label="Horários de funcionamento">
            <input name="hours" defaultValue={inicial.hours} className="campo" placeholder="Seg a Sex, 8h às 18h" maxLength={200} />
          </Field>
        </Grid>
        <div className="mt-3 grid gap-3">
          <Field label="Descrição curta" hint="Aparece no topo da loja e nas buscas (até 400 caracteres).">
            <textarea name="description" defaultValue={inicial.description} className="campo" rows={2} maxLength={400} />
          </Field>
          <Field label="Texto de apresentação">
            <textarea name="presentation" defaultValue={inicial.presentation} className="campo" rows={3} maxLength={2000} />
          </Field>
          <Field label="Informações adicionais" hint="Texto livre: formas de pagamento, o que a locadora entrega, etc.">
            <textarea name="extra_info" defaultValue={inicial.extra_info} className="campo" rows={3} maxLength={2000} />
          </Field>
        </div>
        <Grid cols={3}>
          <Field label="Logotipo">
            <ImageInput name="logo_file" />
            {inicial.logo_url && <img src={inicial.logo_url} alt="Logo atual" className="mt-2 h-12 rounded bg-nuvem-100 object-contain p-1" />}
          </Field>
          <Field label="Banner principal">
            <ImageInput name="banner_file" />
            {inicial.banner_url && <img src={inicial.banner_url} alt="Banner atual" className="mt-2 h-12 rounded bg-nuvem-100 object-cover" />}
          </Field>
          <Field label="Imagem de compartilhamento" hint="Usada no WhatsApp/Google (Open Graph).">
            <ImageInput name="seo_image_file" />
            {inicial.seo_image_url && <img src={inicial.seo_image_url} alt="Compartilhamento atual" className="mt-2 h-12 rounded bg-nuvem-100 object-cover" />}
          </Field>
        </Grid>
      </Section>

      <Section title="Cores e estilo">
        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-3">
            <Field label="Paleta pronta" hint="Paletas harmonizadas; depois é possível ajustar cada cor manualmente.">
              <select className="campo" value={paleta} onChange={(e) => aplicarPaleta(e.target.value)}>
                {PALETAS_LOJA.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.nome}
                  </option>
                ))}
              </select>
            </Field>
            <Grid cols={2}>
              <Field label="Cor principal (botões)">
                <input type="color" name="color_primary" value={cores.primary} onChange={(e) => setCores({ ...cores, primary: e.target.value })} className="h-10 w-full cursor-pointer rounded border border-nuvem-300 bg-white p-1" />
              </Field>
              <Field label="Cor secundária">
                <input type="color" name="color_secondary" value={cores.secondary} onChange={(e) => setCores({ ...cores, secondary: e.target.value })} className="h-10 w-full cursor-pointer rounded border border-nuvem-300 bg-white p-1" />
              </Field>
              <Field label="Cor de destaque">
                <input type="color" name="color_accent" value={cores.accent} onChange={(e) => setCores({ ...cores, accent: e.target.value })} className="h-10 w-full cursor-pointer rounded border border-nuvem-300 bg-white p-1" />
              </Field>
              <Field label="Cor de fundo">
                <input type="color" name="color_background" value={cores.background} onChange={(e) => setCores({ ...cores, background: e.target.value })} className="h-10 w-full cursor-pointer rounded border border-nuvem-300 bg-white p-1" />
              </Field>
              <Field label="Cor do texto">
                <input type="color" name="color_text" value={cores.text} onChange={(e) => setCores({ ...cores, text: e.target.value })} className="h-10 w-full cursor-pointer rounded border border-nuvem-300 bg-white p-1" />
              </Field>
              <Field label="Formato dos botões">
                <select name="button_style" className="campo" value={botao} onChange={(e) => setBotao(e.target.value as "arredondado" | "quadrado")}>
                  <option value="arredondado">Arredondados</option>
                  <option value="quadrado">Retangulares</option>
                </select>
              </Field>
            </Grid>
            <Field label="Título da página (SEO)" hint="Vazio: usa o nome da loja.">
              <input name="seo_title" defaultValue={inicial.seo_title} className="campo" maxLength={70} />
            </Field>
            <Field label="Descrição da página (SEO)" hint="Aparece no Google e ao compartilhar.">
              <textarea name="seo_description" defaultValue={inicial.seo_description} className="campo" rows={2} maxLength={170} />
            </Field>
            <input type="hidden" name="theme" value={paleta} />
          </div>

          {/* Pré-visualização: mesmos tokens da página pública, sem sair da tela */}
          <div className="rounded-xl border border-nuvem-200 p-3">
            <p className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-500">Pré-visualização</p>
            <div className="rounded-xl p-0">
              <style dangerouslySetInnerHTML={{ __html: css }} />
              <div className="overflow-hidden rounded-xl border" style={{ background: "var(--loja-bg)", borderColor: "var(--loja-secondary)", color: "var(--loja-text)" }}>
                <div className="px-4 py-3 text-sm font-bold" style={{ background: "var(--loja-secondary)", color: "#fff" }}>
                  {nome || "Nome da loja"}
                </div>
                <div className="space-y-2 p-4 text-sm">
                  <p>{inicial.description || "Descrição da sua empresa aparece aqui."}</p>
                  <div className="rounded-lg border p-3" style={{ background: "var(--loja-card)", borderColor: "var(--loja-accent)" }}>
                    <p className="font-semibold">Produto em destaque</p>
                    <p className="text-xs opacity-70">R$ 0,00 / diária</p>
                    <button
                      type="button"
                      className="mt-2 px-3 py-1.5 text-xs font-bold text-white"
                      style={{ background: "var(--loja-primary)", borderRadius: "var(--loja-radius)" }}
                    >
                      Adicionar ao pedido
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </Section>

      <Section title="Seções da página">
        <Grid>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="show_banner" defaultChecked={inicial.show_banner === 1} /> Exibir banner principal
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="show_about" defaultChecked={inicial.show_about === 1} /> Exibir apresentação
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="show_delivery" defaultChecked={inicial.show_delivery === 1} /> Exibir entrega/retirada
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="show_faq" defaultChecked={inicial.show_faq === 1} /> Exibir perguntas frequentes
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="show_contact" defaultChecked={inicial.show_contact === 1} /> Exibir botões de contato
          </label>
        </Grid>
        <div className="mt-3 grid gap-3">
          <Field label="Sobre a empresa (seção institucional)">
            <textarea name="about_text" defaultValue={inicial.about_text} className="campo" rows={3} maxLength={4000} />
          </Field>
          <Field label="Entrega e retirada (texto)">
            <textarea name="delivery_text" defaultValue={inicial.delivery_text} className="campo" rows={3} maxLength={4000} />
          </Field>
          <Field label="Perguntas frequentes" hint="Uma por linha, no formato: Pergunta? | Resposta">
            <textarea name="faq_linhas" defaultValue={inicial.faq_linhas} className="campo" rows={4} />
          </Field>
          <Field label="Aviso comercial" hint="Faixa de destaque no topo (ex.: “Entregas grátis acima de R$ 500”).">
            <input name="notice_text" defaultValue={inicial.notice_text} className="campo" maxLength={500} />
          </Field>
        </div>
      </Section>

      <div className="flex justify-end">
        <button type="submit" className={BTN.primario}>
          Salvar aparência
        </button>
      </div>
    </form>
  );
}
