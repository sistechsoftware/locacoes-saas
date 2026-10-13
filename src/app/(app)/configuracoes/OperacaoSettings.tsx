"use client";
import { useState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { Alerta, Badge, Field } from "@/components/ui";
import {
  PERFIS,
  ROTULO_KEY,
  VIS_KEY,
  PERFIL_ROTULO,
  ROTULOS_PADRAO,
  TAMANHO_MAX_ROTULO,
  classificarPerfil,
  type OperacaoConfig,
  type PerfilOperacional,
  type RotuloChave,
  type Rotulos,
  type VisChave,
  type Visibilidade,
} from "@/lib/operacao";
import { restaurarOperacao, saveOperacaoSettings } from "./actions";

const CAMPOS_ROTULO: { chave: RotuloChave; titulo: string; hint: string }[] = [
  { chave: "evento", titulo: "Data e horário do evento", hint: "Rótulo do campo de evento nas reservas e orçamentos." },
  { chave: "evento_hora", titulo: "Horário do evento", hint: "Rótulo do campo de horário do evento (reserva)." },
  { chave: "inicio", titulo: "Início da locação", hint: "Campo de quando a locação começa (entrega/retirada do cliente)." },
  { chave: "fim", titulo: "Fim da locação", hint: "Campo de quando a locação termina (retirada/devolução)." },
];

const CAMPOS_VIS: { chave: VisChave; titulo: string; hint: string }[] = [
  { chave: "evento", titulo: "Exibir campo de evento", hint: "Ocultar mantém os dados gravados e deriva a data do início da locação." },
  { chave: "endereco", titulo: "Exibir endereço do evento", hint: "Endereço, bairro e cidade do local do evento nos formulários." },
  { chave: "montagem", titulo: "Exibir montagem e desmontagem", hint: "Opções e valores de montagem/desmontagem." },
  { chave: "caucao", titulo: "Exibir caução", hint: "Campo de caução em novas reservas. Cauções já registradas continuam gestionáveis." },
];

/**
 * Painel de configuração operacional da empresa (Configurações → Operação).
 *
 * Os perfis apenas PREENCHEM o formulário — nada é gravado até "Salvar", o
 * administrador vê a prévia do que vai mudar e continua livre para ajustar
 * campo a campo. Isso garante que trocar de perfil nunca redefine em silêncio
 * uma configuração personalizada.
 */
export default function OperacaoSettings({ inicial }: { inicial: OperacaoConfig }) {
  const [rotulos, setRotulos] = useState<Rotulos>(inicial.rotulos);
  const [vis, setVis] = useState<Visibilidade>(inicial.vis);
  const [aplicado, setAplicado] = useState<PerfilOperacional | null>(null);

  const perfil = classificarPerfil(rotulos, vis);

  function aplicarPerfil(p: "festas" | "carretinhas") {
    setRotulos({ ...PERFIS[p].rotulos });
    setVis({ ...PERFIS[p].vis });
    setAplicado(p);
  }

  // resumo do que muda em relação ao que está salvo hoje
  const mudancas: string[] = [];
  for (const { chave, titulo } of CAMPOS_ROTULO) {
    if (rotulos[chave] !== inicial.rotulos[chave]) {
      mudancas.push(`${titulo}: "${inicial.rotulos[chave]}" → "${rotulos[chave] || ROTULOS_PADRAO[chave]}"`);
    }
  }
  for (const { chave, titulo } of CAMPOS_VIS) {
    if (vis[chave] !== inicial.vis[chave]) {
      mudancas.push(`${titulo}: ${inicial.vis[chave] ? "visível" : "oculto"} → ${vis[chave] ? "visível" : "oculto"}`);
    }
  }

  return (
    <div className="space-y-4">
      <section className="cartao p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Perfil operacional</h2>
          <Badge tone={perfil === "personalizado" ? "ambar" : "verde"}>
            Atual: {PERFIL_ROTULO[perfil]}{inicial.perfil === perfil ? " (salvo)" : " (não salvo)"}
          </Badge>
        </div>
        <p className="mt-2 text-sm text-stone-500">
          O perfil é apenas um modelo inicial de configuração: ele preenche os campos abaixo e você ajusta o que
          quiser antes de salvar. A troca de perfil nunca altera reservas, orçamentos, cauções ou cobranças já
          registradas.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {(["festas", "carretinhas"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => aplicarPerfil(p)}
              className={`rounded-xl border px-3 py-3 text-left text-sm ${
                aplicado === p ? "border-marca-400 bg-marca-50" : "border-nuvem-300 bg-white"
              }`}
            >
              <span className="block font-bold text-tinta-900">{PERFIL_ROTULO[p]}</span>
              <span className="block text-xs text-stone-500">
                {p === "festas"
                  ? "Evento, endereço, montagem e caução habilitados (padrão do sistema)."
                  : "Retirada/devolução como período; sem evento, endereço, montagem ou caução."}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setAplicado("personalizado")}
            className={`rounded-xl border px-3 py-3 text-left text-sm ${
              aplicado === "personalizado" ? "border-marca-400 bg-marca-50" : "border-nuvem-300 bg-white"
            }`}
          >
            <span className="block font-bold text-tinta-900">{PERFIL_ROTULO.personalizado}</span>
            <span className="block text-xs text-stone-500">Mantém o que está aqui e deixa você configurar cada item.</span>
          </button>
        </div>
      </section>

      <form action={saveOperacaoSettings} className="space-y-4">
        <section className="cartao p-4">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Nomenclaturas</h2>
          <div className="space-y-3">
            {CAMPOS_ROTULO.map(({ chave, titulo, hint }) => (
              <div key={chave}>
                <Field label={titulo} hint={hint}>
                  <div className="flex gap-2">
                    <input
                      name={ROTULO_KEY[chave]}
                      value={rotulos[chave]}
                      maxLength={TAMANHO_MAX_ROTULO}
                      onChange={(e) => setRotulos({ ...rotulos, [chave]: e.target.value })}
                      className="campo flex-1"
                      placeholder={ROTULOS_PADRAO[chave]}
                    />
                    <button
                      type="button"
                      onClick={() => setRotulos({ ...rotulos, [chave]: "" })}
                      className="rounded-xl border border-nuvem-300 bg-white px-3 text-xs font-semibold"
                      title={`Usar o padrão: ${ROTULOS_PADRAO[chave]}`}
                    >
                      Padrão
                    </button>
                  </div>
                </Field>
                <div className="mt-1">
                  {inicial.personalizado[chave] ? (
                    <Badge tone="ambar">Personalizado (padrão: {ROTULOS_PADRAO[chave]})</Badge>
                  ) : (
                    <Badge tone="cinza">Padrão: {ROTULOS_PADRAO[chave]}</Badge>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="cartao p-4">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Campos opcionais</h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {CAMPOS_VIS.map(({ chave, titulo, hint }) => (
              <label
                key={chave}
                className="flex items-start gap-2 rounded-xl border border-nuvem-300 bg-white px-3 py-2.5 text-sm"
                title={hint}
              >
                <input
                  name={VIS_KEY[chave]}
                  type="checkbox"
                  checked={vis[chave]}
                  onChange={(e) => setVis({ ...vis, [chave]: e.target.checked })}
                  className="mt-0.5 h-4 w-4"
                />
                <span>
                  <span className="block font-semibold text-tinta-900">{titulo}</span>
                  <span className="block text-xs text-stone-500">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </section>

        <section className="cartao p-4">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Prévia</h2>
          <div className="space-y-2 rounded-xl bg-nuvem-100 p-3 text-sm">
            <p className="font-semibold text-tinta-900">Cliente</p>
            {vis.evento && (
              <p>
                <span className="text-stone-600">{rotulos.evento || ROTULOS_PADRAO.evento} · </span>
                <span className="text-stone-600">{rotulos.evento_hora || ROTULOS_PADRAO.evento_hora}</span>
              </p>
            )}
            <p>
              <span className="font-semibold text-tinta-900">{rotulos.inicio || ROTULOS_PADRAO.inicio}</span>
              <span className="text-stone-500"> — início da locação</span>
            </p>
            <p>
              <span className="font-semibold text-tinta-900">{rotulos.fim || ROTULOS_PADRAO.fim}</span>
              <span className="text-stone-500"> — fim da locação</span>
            </p>
            {vis.endereco && <p className="text-stone-600">Endereço do evento (bairro, cidade)</p>}
            {vis.montagem && <p className="text-stone-600">Montagem · Desmontagem</p>}
            {vis.caucao && <p className="text-stone-600">Caução (R$)</p>}
            {!vis.evento && <p className="text-xs text-stone-400">Campo de evento oculto — a data interna deriva do início da locação.</p>}
            {!vis.endereco && <p className="text-xs text-stone-400">Endereço do evento oculto — dados já gravados são preservados.</p>}
            {!vis.montagem && <p className="text-xs text-stone-400">Montagem e desmontagem ocultas — valores já lançados permanecem.</p>}
            {!vis.caucao && <p className="text-xs text-stone-400">Caução oculta em novas operações — cobranças e cauções existentes não são alteradas.</p>}
          </div>
        </section>

        {mudancas.length > 0 && (
          <Alerta tone="ambar" title="Alterações ainda não salvas">
            <ul className="list-inside list-disc space-y-0.5">
              {mudancas.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <p className="mt-1">Nada disso vale até você salvar; reservas e orçamentos existentes não são modificados.</p>
          </Alerta>
        )}

        <SubmitButton>Salvar configuração operacional</SubmitButton>
      </form>

      <section className="cartao p-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Restaurar padrões</h2>
        <p className="mt-2 text-sm text-stone-500">
          Volta nomenclaturas e campos opcionais ao padrão do sistema ({PERFIL_ROTULO.festas}), sem apagar nenhum dado
          de reservas, orçamentos ou cauções.
        </p>
        <form
          action={restaurarOperacao}
          className="mt-3"
          onSubmit={(e) => {
            if (!confirm("Restaurar os padrões da configuração operacional? Os dados gravados não serão alterados.")) {
              e.preventDefault();
            }
          }}
        >
          <SubmitButton variant="secundario">Restaurar valores padrão</SubmitButton>
        </form>
      </section>
    </div>
  );
}
