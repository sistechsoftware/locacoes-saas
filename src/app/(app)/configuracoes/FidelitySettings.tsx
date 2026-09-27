"use client";
import { useState } from "react";
import { Alerta, Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import { RESERVATION_STATUS } from "@/lib/domain";
import { EVENTOS, MODELOS_PADRAO, VARIAVEIS_FIDELIDADE, type EventoFidelidade } from "@/lib/fidelidade";
import { saveFidelitySettings } from "./actions";

/**
 * Configuracao do programa de fidelidade.
 *
 * Tudo aqui e regra de negocio que o dono do negocio muda sozinho: meta, kits,
 * validade, o que conta como locacao e o texto das mensagens. Trocar 5 por 3 ou
 * por 10 nao pode exigir programador.
 */
export default function FidelitySettings({
  settings,
  admin,
}: {
  settings: Record<string, string>;
  admin: boolean;
}) {
  const [ativo, setAtivo] = useState(settings.fidelity_active !== "0");
  const [statusMarcados, setStatusMarcados] = useState<string[]>(
    String(settings.fidelity_eligible_status ?? "retirada,finalizada").split(",").map((t) => t.trim()).filter(Boolean),
  );

  const alterna = (valor: string) =>
    setStatusMarcados((atuais) =>
      atuais.includes(valor) ? atuais.filter((v) => v !== valor) : [...atuais, valor],
    );

  const eventos: EventoFidelidade[] = ["progresso", "quase_la", "conquista", "uso", "vencendo", "expirada"];
  const chaveAviso: Record<string, string> = {
    progresso: "fidelity_notify_progress",
    quase_la: "fidelity_notify_almost",
    conquista: "fidelity_notify_earned",
    uso: "fidelity_notify_used",
    vencendo: "fidelity_notify_expiring",
    expirada: "fidelity_notify_expired",
  };

  return (
    <form action={saveFidelitySettings} className="space-y-4">
      <input type="hidden" name="active" value={ativo ? "1" : "0"} />
      <input type="hidden" name="eligible_status" value={statusMarcados.join(",")} />

      <section className="cartao p-4">
        <label className="flex items-center gap-2 text-sm font-bold text-tinta-900">
          <input
            type="checkbox"
            checked={ativo}
            onChange={(e) => setAtivo(e.target.checked)}
            disabled={!admin}
            className="h-4 w-4"
          />
          Programa de Fidelidade ativo
        </label>
        <p className="mt-1 text-xs text-stone-500">
          Desligado, nada é pontuado. As recompensas já conquistadas continuam valendo.
        </p>
      </section>

      <section className="cartao p-4">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Regra</h3>
        <Grid>
          <Field label="Locações para ganhar" hint="A meta do ciclo.">
            <input
              name="goal"
              type="number"
              min={1}
              max={100}
              defaultValue={settings.fidelity_goal ?? "5"}
              className="campo"
              disabled={!admin}
            />
          </Field>
          <Field label="Kits grátis por recompensa">
            <input
              name="kits"
              type="number"
              min={0}
              max={100}
              defaultValue={settings.fidelity_kits ?? "5"}
              className="campo"
              disabled={!admin}
            />
          </Field>
          <Field label="Validade (dias)" hint="0 = a recompensa não expira.">
            <input
              name="validity_days"
              type="number"
              min={0}
              max={3650}
              defaultValue={settings.fidelity_validity_days ?? "0"}
              className="campo"
              disabled={!admin}
            />
          </Field>
          <Field label="Valor mínimo da locação (R$)" hint="0 = qualquer valor conta.">
            <input
              name="min_value"
              inputMode="decimal"
              defaultValue={((Number(settings.fidelity_min_value_cents ?? 0) || 0) / 100).toFixed(2)}
              className="campo"
              disabled={!admin}
            />
          </Field>
        </Grid>

        <div className="mt-3 space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="accumulate"
              value="1"
              defaultChecked={settings.fidelity_accumulate !== "0"}
              disabled={!admin}
              className="h-4 w-4"
            />
            Acumular recompensas (10 locações = 2 recompensas)
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="count_free_rental"
              value="1"
              defaultChecked={settings.fidelity_count_free_rental === "1"}
              disabled={!admin}
              className="h-4 w-4"
            />
            Locação paga com recompensa também pontua
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="return_on_cancel"
              value="1"
              defaultChecked={settings.fidelity_return_on_cancel !== "0"}
              disabled={!admin}
              className="h-4 w-4"
            />
            Devolver a recompensa se a locação que a usou for cancelada
          </label>
        </div>
      </section>

      <section className="cartao p-4">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-stone-500">O que conta como locação</h3>
        <p className="mb-3 text-xs text-stone-500">
          Marque os status em que a locação já foi realizada. Orçamento e reserva cancelada não devem contar.
        </p>
        <div className="flex flex-wrap gap-2">
          {RESERVATION_STATUS.filter((s) => s.value !== "cancelada").map((s) => (
            <label
              key={s.value}
              className={`cursor-pointer rounded-full border px-3 py-1.5 text-sm font-semibold ${
                statusMarcados.includes(s.value)
                  ? "border-marca-400 bg-marca-50 text-marca-700"
                  : "border-nuvem-300 bg-white text-stone-600"
              }`}
            >
              <input
                type="checkbox"
                checked={statusMarcados.includes(s.value)}
                onChange={() => alterna(s.value)}
                disabled={!admin}
                className="sr-only"
              />
              {s.label}
            </label>
          ))}
        </div>
        {statusMarcados.length === 0 && (
          <Alerta tone="ambar" title="Nenhum status marcado">
            Sem status marcado nada pontua, o que na prática desliga o programa.
          </Alerta>
        )}
      </section>

      <section className="cartao p-4">
        <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Avisos</h3>
        <Grid>
          <Field label="Lembretes de vencimento" hint="Dias de antecedência, separados por vírgula.">
            <input
              name="expiry_reminders"
              defaultValue={settings.fidelity_expiry_reminders ?? "7,3,1"}
              className="campo"
              disabled={!admin}
            />
          </Field>
          <Field label="Horário permitido" hint="Avisos fora da janela esperam o próximo horário.">
            <div className="flex items-center gap-2">
              <input
                name="window_start"
                type="time"
                defaultValue={settings.fidelity_window_start ?? "08:00"}
                className="campo"
                disabled={!admin}
              />
              <span className="text-sm text-stone-500">até</span>
              <input
                name="window_end"
                type="time"
                defaultValue={settings.fidelity_window_end ?? "20:00"}
                className="campo"
                disabled={!admin}
              />
            </div>
          </Field>
        </Grid>

        <div className="mt-3 space-y-1.5">
          {eventos.map((e) => (
            <label key={e} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name={chaveAviso[e]}
                value="1"
                defaultChecked={settings[chaveAviso[e]] === "1"}
                disabled={!admin}
                className="h-4 w-4"
              />
              {EVENTOS[e]}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-stone-500">
          O envio ao cliente é pelo WhatsApp, com a mensagem pronta em Fidelidade. A equipe recebe o aviso na central de
          notificações.
        </p>
      </section>

      <section className="cartao p-4">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-stone-500">Mensagens</h3>
        <p className="mb-3 text-xs text-stone-500">
          Campos disponíveis: {VARIAVEIS_FIDELIDADE.map((v) => `{${v}}`).join(", ")}. Campo sem valor sai vazio.
        </p>
        <div className="space-y-3">
          {eventos.map((e) => (
            <Field key={e} label={EVENTOS[e]}>
              <textarea
                name={`msg_${e}`}
                defaultValue={settings[`fidelity_msg_${e}`] ?? MODELOS_PADRAO[e]}
                rows={2}
                className="campo text-xs"
                disabled={!admin}
              />
            </Field>
          ))}
        </div>
      </section>

      {admin && <SubmitButton>Salvar Fidelidade</SubmitButton>}
    </form>
  );
}
