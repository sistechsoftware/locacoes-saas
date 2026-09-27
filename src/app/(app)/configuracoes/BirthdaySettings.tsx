"use client";
import { useState } from "react";
import { Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { saveBirthdaySettings } from "./actions";

/**
 * Avisos de aniversario.
 *
 * A tela de aniversariantes funciona independentemente disso: aqui se controla
 * apenas o aviso automatico, que e o que pode incomodar quem nao quer.
 */
export default function BirthdaySettings({ settings, admin }: { settings: Record<string, string>; admin: boolean }) {
  const [ativo, setAtivo] = useState(settings.birthday_active !== "0");

  return (
    <form action={saveBirthdaySettings} className="space-y-4">
      <input type="hidden" name="active" value={ativo ? "1" : "0"} />

      <section className="cartao p-4">
        <label className="flex items-center gap-2 text-sm font-bold text-tinta-900">
          <input
            type="checkbox"
            checked={ativo}
            onChange={(e) => setAtivo(e.target.checked)}
            disabled={!admin}
            className="h-4 w-4"
          />
          Avisar automaticamente sobre aniversários
        </label>
        <p className="mt-1 text-xs text-stone-500">
          Desligado, a tela de Aniversariantes continua disponível, mas o sistema não gera aviso nem push.
        </p>
      </section>

      <section className="cartao p-4">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Quando avisar</h3>
        <Grid>
          <Field label="Antecedência (dias)" hint="Quantos dias antes o sistema avisa. 0 avisa somente no dia.">
            <input
              name="days_ahead"
              type="number"
              min={0}
              max={366}
              defaultValue={settings.birthday_days_ahead ?? "7"}
              className="campo"
              disabled={!admin}
            />
          </Field>
          <Field label="Hora do aviso" hint="A rotina roda a partir dessa hora, uma vez por dia.">
            <input
              name="hour"
              type="number"
              min={0}
              max={23}
              defaultValue={settings.birthday_hour ?? "8"}
              className="campo"
              disabled={!admin}
            />
          </Field>
        </Grid>

        <div className="mt-3 space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="notify_today"
              value="1"
              defaultChecked={settings.birthday_notify_today !== "0"}
              disabled={!admin}
              className="h-4 w-4"
            />
            Avisar sobre os aniversariantes do dia
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="notify_upcoming"
              value="1"
              defaultChecked={settings.birthday_notify_upcoming !== "0"}
              disabled={!admin}
              className="h-4 w-4"
            />
            Avisar sobre os aniversários próximos
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="push"
              value="1"
              defaultChecked={settings.birthday_push !== "0"}
              disabled={!admin}
              className="h-4 w-4"
            />
            Enviar também como notificação no celular
          </label>
        </div>
        <p className="mt-2 text-xs text-stone-500">
          O aviso vai para o sino de todos os usuários ativos. Quem desligou o tipo &quot;Aniversariantes&quot; nas suas
          preferências não recebe push.
        </p>
      </section>

      {admin && <SubmitButton>Salvar Aniversários</SubmitButton>}
    </form>
  );
}
