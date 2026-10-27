"use client";
import { useEffect, useState } from "react";
import { Alerta, Badge, BTN, Section } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { saveIdentidadeVisual } from "./actions";
import {
  LISTA_TEMAS,
  TEMA_PADRAO,
  resolverTema,
  variaveisDoTema,
  type Tema,
} from "@/lib/temas";

/**
 * Configurações → Identidade visual.
 *
 * Fluxo: escolher na grade → PRÉVIA → salvar. A prévia é temporária: aplica as
 * variáveis no <html> enquanto o usuário compara e some sozinha quando a tela
 * desmonta (troca de aba/navegação) ou quando o tema escolhido volta a ser o
 * já salvo. Nada disso toca no banco — company_settings só muda no submit.
 *
 * O cliente envia SOMENTE o id da paleta. Toda a autorização, a validação e a
 * gravação acontecem na server action (assertAdmin + temaConhecido + escopo de
 * empresa do contexto autenticado).
 */
export default function IdentidadeVisual({ temaAtual }: { temaAtual: string }) {
  const salvo = resolverTema(temaAtual);
  const [selecionado, setSelecionado] = useState<string>(salvo.id);

  /* Depois de salvar/restaurar o servidor devolve o novo tema ativo e a
     seleção acompanha — sem isso, restaurar voltaria a marcar paleta antiga e
     a prévia recomeçaria logo depois do submit. */
  useEffect(() => {
    setSelecionado(salvo.id);
  }, [salvo.id]);

  /* Prévia global: variáveis inline em documentElement, que vencem qualquer
     folha de estilo (inclusive o <style> do layout quando já há tema salvo). */
  useEffect(() => {
    if (selecionado === salvo.id) return;
    const alvo = document.documentElement;
    const vars = variaveisDoTema(resolverTema(selecionado));
    for (const [chave, valor] of Object.entries(vars)) alvo.style.setProperty(chave, valor);
    return () => {
      for (const chave of Object.keys(vars)) alvo.style.removeProperty(chave);
    };
  }, [selecionado, salvo.id]);

  const emPrevia = selecionado !== salvo.id;
  const tema: Tema = resolverTema(selecionado);

  return (
    <Section title="Identidade visual">
      <div className="space-y-4">
        <p className="text-sm text-stone-600">
          Escolha a combinação de cores que toda a equipe vai ver neste sistema — menu, cabeçalho, botões,
          cartões, formulários e destaques. A escolha é desta empresa apenas; nenhum outro cliente é afetado e
          nenhum dado, permissão ou cadastro muda junto.
        </p>

        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-stone-500">Tema ativo agora:</span>
          <Badge tone={salvo.id === TEMA_PADRAO ? "cinza" : "azul"}>{salvo.nome}</Badge>
          {emPrevia && <Badge tone="ambar">Prévia de {tema.nome} — ainda não salva</Badge>}
        </div>

        {/* ------------------------------ grade ------------------------------ */}
        <div role="radiogroup" aria-label="Paletas disponíveis" className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {LISTA_TEMAS.map((t) => {
            const ativo = t.id === selecionado;
            const ehSalvo = t.id === salvo.id;
            return (
              <label
                key={t.id}
                className={`flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition ${
                  ativo ? "border-marca-600 bg-marca-50 ring-1 ring-marca-600" : "border-nuvem-300 bg-white hover:bg-nuvem-50"
                }`}
              >
                <input
                  type="radio"
                  name="tema_escolha"
                  value={t.id}
                  checked={ativo}
                  onChange={() => setSelecionado(t.id)}
                  className="mt-1 h-4 w-4 shrink-0 accent-marca-600"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <b className="text-sm text-tinta-900">{t.nome}</b>
                    {ehSalvo && <Badge tone="verde">Em uso</Badge>}
                  </span>
                  <span className="mt-1 block text-xs text-stone-500">{t.descricao}</span>
                  {/* as 4 cores que resumem a paleta: ação, acento, superfície e tinta */}
                  <span className="mt-2 flex items-center gap-1">
                    {[
                      t.cores.marca["600"],
                      t.cores.marca["100"],
                      t.cores.destaque["500"],
                      t.cores.nuvem["100"],
                      t.cores.tinta["900"],
                    ].map((cor, i) => (
                      <span
                        key={i}
                        className="h-5 w-5 rounded-md border border-black/10"
                        style={{ background: cor }}
                        title={cor}
                      />
                    ))}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {/* ------------------------------ prévia ------------------------------ */}
        <div>
          <p className="rotulo">Prévia do sistema com {tema.nome}</p>
          <PreviaFrame tema={tema} />
          <p className="mt-1.5 text-xs text-stone-500">
            Enquanto você compara, a aplicação inteira já usa a paleta escolhida — é prévia, não está salva.
            Ao sair da tela ou recarregar, o tema voltar ao que está gravado.
          </p>
        </div>

        {/* ------------------------------ ações ------------------------------- */}
        <div className="flex flex-wrap items-center gap-2">
          <form action={saveIdentidadeVisual}>
            <input type="hidden" name="tema" value={selecionado} />
            <SubmitButton disabled={!emPrevia}>
              {emPrevia
                ? "Salvar tema"
                : salvo.id === TEMA_PADRAO
                  ? "Tema original em uso"
                  : `Tema ${salvo.nome} em uso`}
            </SubmitButton>
          </form>

          <form action={saveIdentidadeVisual}>
            <input type="hidden" name="tema" value={TEMA_PADRAO} />
            <SubmitButton variant="secundario" disabled={salvo.id === TEMA_PADRAO}>
              Restaurar tema original do Locô
            </SubmitButton>
          </form>

          {emPrevia && (
            <button type="button" onClick={() => setSelecionado(salvo.id)} className={BTN.fantasma}>
              Descartar prévia
            </button>
          )}
        </div>

        <Alerta tone="azul">
          As cores de sucesso, erro, alerta e informação não mudam com o tema — elas continuam comunicando o
          mesmo significado em qualquer combinação.
        </Alerta>
      </div>
    </Section>
  );
}

/**
 * Miniatura do shell real, montada com os MESMOS tokens e componentes do
 * produto: menu lateral, cabeçalho, cartão com cabeçalho, botões, campo de
 * formulário, badges de status e um indicador de destaque. Como todos os
 * utilitários do Tailwind v4 leem var(--color-*), sobrepor as variáveis neste
 * contêiner reproduz exatamente o que a tela vai parecer.
 */
function PreviaFrame({ tema }: { tema: Tema }) {
  const vars = variaveisDoTema(tema) as unknown as React.CSSProperties;
  return (
    <div
      className="overflow-hidden rounded-xl border border-nuvem-300"
      style={vars}
      data-testid="previa-identidade"
    >
      <div className="flex min-h-56 bg-nuvem-100">
        {/* menu lateral */}
        <div className="hidden w-36 shrink-0 border-r border-nuvem-300 bg-white p-2 sm:block">
          <div className="mb-2 flex items-center gap-2 border-b border-nuvem-200 px-1 pb-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-marca-600 text-xs font-black text-white">
              L
            </span>
            <span className="truncate text-[0.68rem] font-bold text-tinta-900">Sua Empresa</span>
          </div>
          <div className="space-y-0.5">
            {[
              { label: "Dashboard", ativo: true },
              { label: "Agenda", ativo: false },
              { label: "Reservas", ativo: false },
              { label: "Financeiro", ativo: false },
            ].map((n) => (
              <span
                key={n.label}
                className={`flex rounded-lg px-2 py-1.5 text-[0.68rem] font-medium ${
                  n.ativo ? "bg-marca-600 text-white" : "text-tinta-700"
                }`}
              >
                {n.label}
              </span>
            ))}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          {/* cabeçalho */}
          <div className="flex items-center gap-2 border-b border-nuvem-300 bg-white/95 px-3 py-2">
            <span className="flex-1 truncate rounded-lg border border-nuvem-300 bg-nuvem-50 px-2 py-1 text-[0.68rem] text-stone-400 focus:border-marca-400 focus:bg-white">
              Buscar cliente ou reserva…
            </span>
            <span className="rounded-lg px-2 py-1 text-[0.68rem] font-semibold text-marca-600 hover:bg-marca-50">
              Ajuda
            </span>
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-marca-600 text-[0.6rem] font-bold text-white">
              AS
            </span>
          </div>

          {/* conteúdo */}
          <div className="space-y-2 p-3">
            <div className="cartao overflow-hidden">
              <div className="flex items-center justify-between border-b border-nuvem-200 bg-nuvem-50 px-3 py-2">
                <span className="text-[0.62rem] font-bold uppercase tracking-wide text-stone-600">
                  Reservas do dia
                </span>
                <span className="rounded-full border border-destaque-300 bg-destaque-100 px-1.5 py-0.5 text-[0.58rem] font-bold text-destaque-700">
                  Destaque
                </span>
              </div>
              <div className="space-y-2 p-3">
                <div className="flex flex-wrap gap-1">
                  <span className="rounded-full border border-emerald-300 bg-emerald-100 px-2 py-0.5 text-[0.6rem] font-semibold text-emerald-800">
                    Confirmada
                  </span>
                  <span className="rounded-full border border-amber-300 bg-amber-100 px-2 py-0.5 text-[0.6rem] font-semibold text-amber-800">
                    Aguardando
                  </span>
                  <span className="rounded-full border border-red-300 bg-red-100 px-2 py-0.5 text-[0.6rem] font-semibold text-red-800">
                    Cancelada
                  </span>
                  <span className="rounded-full border border-sky-300 bg-sky-100 px-2 py-0.5 text-[0.6rem] font-semibold text-sky-800">
                    Entregue
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <div className="rounded-lg border border-nuvem-300 bg-white p-2 transition hover:border-marca-300">
                    <p className="text-[0.55rem] font-semibold uppercase text-stone-500">Reservas</p>
                    <p className="text-base font-bold text-tinta-900">128</p>
                  </div>
                  <div className="rounded-lg border border-nuvem-300 bg-white p-2 transition hover:border-marca-300">
                    <p className="text-[0.55rem] font-semibold uppercase text-stone-500">A receber</p>
                    <p className="text-base font-bold text-emerald-600">R$ 12.480</p>
                  </div>
                  <div className="rounded-lg border border-nuvem-300 bg-white p-2 transition hover:border-marca-300">
                    <p className="text-[0.55rem] font-semibold uppercase text-stone-500">Em atraso</p>
                    <p className="text-base font-bold text-red-600">R$ 930</p>
                  </div>
                </div>

                <label className="block">
                  <span className="rotulo">Observação</span>
                  <span className="campo block truncate text-[0.7rem] text-tinta-900">Texto digitado no campo</span>
                </label>

                <div className="flex flex-wrap gap-2">
                  <span className={`${BTN.primario} pointer-events-none px-3 py-1.5 text-xs`}>Nova Reserva</span>
                  <span className={`${BTN.secundario} pointer-events-none px-3 py-1.5 text-xs`}>Cancelar</span>
                  <span className={`${BTN.fantasma} pointer-events-none px-3 py-1.5 text-xs`}>Ver detalhes</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}