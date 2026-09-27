"use client";

import { useState } from "react";
import { Field, Grid, Section } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { TAMANHOS_RECIBO_LISTA, tamanhoRecibo } from "@/lib/recibo-visual";
import { saveReciboSettings } from "./actions";

/**
 * Configuração do tamanho do recibo (Configurações → Recibos).
 *
 * Uma configuração central: vale para recibo de pagamento, adiantamento,
 * caução e quitação — não existe tamanho por tipo. O padrão A4 preserva o
 * comportamento atual; os formatos compactos reorganizam o layout (a página
 * do recibo reduz margens e tipografia sem cortar informação). A
 * pré-visualização mostra a proporção da folha escolhida, não o recibo em si.
 */
export default function ReciboSettings({
  settings,
  admin,
}: {
  settings: Record<string, string>;
  admin: boolean;
}) {
  const [tamanho, setTamanho] = useState(settings.recibo_tamanho || "a4");
  const [largura, setLargura] = useState(settings.recibo_largura_mm || "105");
  const [altura, setAltura] = useState(settings.recibo_altura_mm || "148");

  // retrato do formato escolhido (com os valores digitados, no personalizado)
  const efetivo = tamanhoRecibo(
    { ...settings, recibo_tamanho: tamanho },
    tamanho === "personalizado" ? { larguraMm: largura, alturaMm: altura } : undefined,
  );

  // proporção da pré-visualização: a altura da folha em escala, com piso para
  // caber o desenho interno; A4 (altura 297) entra em modo "contínuo"
  const larguraPx = Math.max(70, Math.min(190, efetivo.larguraMm * 1.1));
  const alturaPx = efetivo.alturaMm ? Math.max(120, Math.min(340, efetivo.alturaMm * (larguraPx / efetivo.larguraMm))) : 320;

  return (
    <Section title="Tamanho do recibo">
      <form action={saveReciboSettings} className="space-y-3">
        <Grid>
          <Field
            label="Tamanho do recibo"
            hint="Vale para todos os recibos: pagamento, adiantamento, caução e quitação. Afeta apenas novas impressões — documentos já emitidos permanecem como estão."
          >
            <select
              name="recibo_tamanho"
              value={tamanho}
              onChange={(e) => setTamanho(e.target.value)}
              className="campo"
              disabled={!admin}
            >
              {TAMANHOS_RECIBO_LISTA.map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
        </Grid>

        {tamanho === "personalizado" && (
          <Grid>
            <Field label="Largura (mm)" hint="Entre 50 e 297 mm.">
              <input
                name="recibo_largura_mm"
                value={largura}
                onChange={(e) => setLargura(e.target.value)}
                inputMode="decimal"
                className="campo"
                disabled={!admin}
              />
            </Field>
            <Field label="Altura (mm)" hint="Entre 50 e 297 mm.">
              <input
                name="recibo_altura_mm"
                value={altura}
                onChange={(e) => setAltura(e.target.value)}
                inputMode="decimal"
                className="campo"
                disabled={!admin}
              />
            </Field>
          </Grid>
        )}

        {/* pré-visualização: proporção da folha, com miniatura do conteúdo */}
        <div className="rounded-xl border border-nuvem-300 bg-nuvem-50 p-4">
          <p className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-500">Pré-visualização</p>
          <div className="flex items-start gap-4">
            <div
              className="flex flex-col gap-1.5 rounded-md border-2 border-marca-400 bg-white p-2 shadow-sm"
              style={{ width: larguraPx, minHeight: alturaPx }}
            >
              <div className="flex items-center justify-between border-b-2 border-marca-600 pb-1">
                <div className="h-3 w-8 rounded bg-marca-600/80" />
                <div className="h-2 w-6 rounded bg-stone-300" />
              </div>
              <div className="h-1.5 w-4/5 rounded bg-stone-300" />
              <div className="h-1.5 w-3/5 rounded bg-stone-200" />
              <div className="mt-1 rounded border border-marca-400 px-1.5 py-1 text-center">
                <span className="text-[9px] font-bold text-marca-700">R$ 150,00</span>
              </div>
              <div className="h-1.5 w-2/3 rounded bg-stone-200" />
              <div className="mt-auto border-t border-stone-400 pt-1 text-center">
                <div className="mx-auto h-3 w-12 border-b border-tinta-900" />
                <div className="mt-0.5 h-1 w-10 mx-auto rounded bg-stone-300" />
              </div>
            </div>
            <p className="max-w-[16rem] text-xs text-stone-500">
              <b>{efetivo.label}</b>
              <br />
              {efetivo.larguraMm} mm de largura
              {efetivo.alturaMm ? ` × ${efetivo.alturaMm} mm de altura` : ", altura contínua"}. A impressão sai
              exatamente neste tamanho, sem ajuste manual de escala — e o layout se reorganiza nos formatos compactos,
              sem cortar informação.
            </p>
          </div>
        </div>

        {admin && <SubmitButton>Salvar Tamanho do Recibo</SubmitButton>}
      </form>
    </Section>
  );
}
