"use client";
import { useEffect, useState, useActionState } from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { Alerta, Badge, Field } from "@/components/ui";
import {
  OPERACAO_KEYS,
  PERFIS,
  ROTULO_KEY,
  VIS_KEY,
  PERFIL_ROTULO,
  ROTULOS_PADRAO,
  TAMANHO_MAX_ROTULO,
  tituloOperacoes,
  type OperacaoConfig,
  type PerfilOperacional,
  type RotuloChave,
  type Rotulos,
  type VisChave,
  type Visibilidade,
} from "@/lib/operacao";
import { restaurarOperacao, saveOperacaoSettings, type ResultadoOperacaoSave } from "./actions";

const CAMPOS_ROTULO: { chave: RotuloChave; titulo: string; hint: string }[] = [
  { chave: "evento", titulo: "Data e horário do evento", hint: "Rótulo do campo de evento nas reservas e orçamentos." },
  { chave: "evento_hora", titulo: "Horário do evento", hint: "Rótulo do campo de horário do evento (reserva)." },
  { chave: "inicio", titulo: "Início da locação", hint: "Campo de quando a locação começa." },
  { chave: "fim", titulo: "Fim da locação", hint: "Campo de quando a locação termina." },
  {
    chave: "operacao_inicio",
    titulo: "Operação inicial",
    hint: "Nome curto usado nos checkboxes de serviços, menu, agenda, cartões e estatísticas (padrão: Entrega).",
  },
  {
    chave: "operacao_fim",
    titulo: "Operação final",
    hint: "Nome curto da operação de fim, nos mesmos lugares (padrão: Retirada).",
  },
];

const CAMPOS_VIS: { chave: VisChave; titulo: string; hint: string }[] = [
  { chave: "evento", titulo: "Exibir campo de evento", hint: "Ocultar mantém os dados gravados e deriva a data do início da locação." },
  { chave: "endereco", titulo: "Exibir endereço do evento", hint: "Endereço, bairro e cidade do local do evento nos formulários." },
  { chave: "montagem", titulo: "Exibir montagem e desmontagem", hint: "Opções e valores de montagem/desmontagem." },
  { chave: "caucao", titulo: "Exibir caução", hint: "Campo de caução em novas reservas. Cauções já registradas continuam gestionáveis." },
];

type Estado = { rotulos: Rotulos; vis: Visibilidade; perfil: PerfilOperacional };

/**
 * Painel de configuração operacional da empresa (Configurações → Operação).
 *
 * Confiabilidade do salvamento (auditoria de perfis):
 *  - o PERFIL é um estado explícito do formulário e vai gravado no servidor
 *    (op_perfil) — "Personalizado" é perfil de primeira classe, não um
 *    "sobra" de classificação; escolher presets preenche os campos e pedir
 *    "Personalizado" preserva o que estiver na tela;
 *  - qualquer edição manual que saia do preset selecionado marca o perfil
 *    como "Personalizado" de forma explícita e visível;
 *  - o servidor responde com sucesso/erro de verdade (useActionState): a
 *    tela só mostra "salvo" depois da persistência, e erro de validação
 *    aparece sem derrubar o formulário;
 *  - o estado local ressincroniza com o servidor quando NÃO há edição em
 *    andamento (ex.: outro administrador salvou) — e nunca sobrescreve o que
 *    você está digitando.
 */
export default function OperacaoSettings({ inicial }: { inicial: OperacaoConfig }) {
  const [estado, setEstado] = useState<Estado>({
    rotulos: inicial.rotulos,
    vis: inicial.vis,
    perfil: inicial.perfil,
  });
  /* Editou desde o último sync/salvamento? Enquanto sujo, nada vindo do
     servidor sobrescreve a tela. */
  const [sujo, setSujo] = useState(false);
  const [salvadoAgora, setSalvadoAgora] = useState(false);
  const [resultadoRestore, submitRestore, restorePendente] = useActionState<
    ResultadoOperacaoSave | null,
    FormData
  >(async () => restaurarOperacao(), null);

  const [estadoSalvar, submitSalvar, salvarPendente] = useActionState<
    ResultadoOperacaoSave | null,
    FormData
  >(async (_prev, fd) => saveOperacaoSettings(fd), null);

  // chave serializada: o efeito só roda quando os dados do SERVIDOR mudam,
  // não a cada renderização (objetos novos a cada request)
  const chaveServidor = JSON.stringify([inicial.perfil, inicial.rotulos, inicial.vis]);
  useEffect(() => {
    if (sujo) return; // nunca sobrescrever uma edição em andamento
    setEstado({ rotulos: inicial.rotulos, vis: inicial.vis, perfil: inicial.perfil });
    setSalvadoAgora(false);
  }, [chaveServidor]); // eslint-disable-line react-hooks/exhaustive-deps

  // um salvamento bem-sucedido zera a sujeira e deixa o servidor mandar
  useEffect(() => {
    if (estadoSalvar?.ok) {
      setSujo(false);
      setSalvadoAgora(true);
    }
  }, [estadoSalvar]);

  function aplicarPerfil(p: "festas" | "carretinhas" | "personalizado") {
    setSalvadoAgora(false);
    if (p === "personalizado") {
      // escolha explícita: preserva exatamente o que está na tela
      setEstado((e) => ({ ...e, perfil: "personalizado" }));
      setSujo(true);
      return;
    }
    setEstado({ rotulos: { ...PERFIS[p].rotulos }, vis: { ...PERFIS[p].vis }, perfil: p });
    setSujo(true);
  }

  function editar(chave: RotuloChave, valor: string) {
    setSalvadoAgora(false);
    setEstado((e) => {
      const rotulos = { ...e.rotulos, [chave]: valor };
      // edição manual que sai do preset selecionado vira "Personalizado"
      const perfil =
        e.perfil === "personalizado" || valoresIguais(e.perfil, rotulos, e.vis)
          ? e.perfil
          : "personalizado";
      return { ...e, rotulos, perfil };
    });
    setSujo(true);
  }

  function alternarVis(chave: VisChave, valor: boolean) {
    setSalvadoAgora(false);
    setEstado((e) => {
      const vis = { ...e.vis, [chave]: valor };
      const perfil =
        e.perfil === "personalizado" || valoresIguais(e.perfil, e.rotulos, vis) ? e.perfil : "personalizado";
      return { ...e, vis, perfil };
    });
    setSujo(true);
  }

  function valoresIguais(perfil: PerfilOperacional, rotulos: Rotulos, vis: Visibilidade): boolean {
    if (perfil === "personalizado") return true;
    const preset = PERFIS[perfil];
    return (Object.keys(preset.rotulos) as RotuloChave[]).every((k) => rotulos[k] === preset.rotulos[k])
      && (Object.keys(preset.vis) as VisChave[]).every((k) => vis[k] === preset.vis[k]);
  }

  // resumo do que muda em relação ao que está salvo hoje
  const mudancas: string[] = [];
  if (estado.perfil !== inicial.perfil) {
    mudancas.push(`Perfil: ${PERFIL_ROTULO[inicial.perfil]} → ${PERFIL_ROTULO[estado.perfil]}`);
  }
  for (const { chave, titulo } of CAMPOS_ROTULO) {
    if (estado.rotulos[chave] !== inicial.rotulos[chave]) {
      mudancas.push(`${titulo}: "${inicial.rotulos[chave]}" → "${estado.rotulos[chave] || ROTULOS_PADRAO[chave]}"`);
    }
  }
  for (const { chave, titulo } of CAMPOS_VIS) {
    if (estado.vis[chave] !== inicial.vis[chave]) {
      mudancas.push(`${titulo}: ${inicial.vis[chave] ? "visível" : "oculto"} → ${estado.vis[chave] ? "visível" : "oculto"}`);
    }
  }

  const configAtual: OperacaoConfig = {
    perfil: estado.perfil,
    rotulos: estado.rotulos,
    vis: estado.vis,
    personalizado: inicial.personalizado,
  };

  return (
    <div className="space-y-4">
      <section className="cartao p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Perfil operacional</h2>
          <Badge tone={estado.perfil === "personalizado" ? "ambar" : "verde"}>
            Atual: {PERFIL_ROTULO[estado.perfil]}
            {sujo ? " (não salvo)" : " (salvo)"}
          </Badge>
        </div>
        <p className="mt-2 text-sm text-stone-500">
          O perfil é um modelo inicial de configuração: os presets preenchem os campos abaixo e você ajusta o
          que quiser antes de salvar. Escolher <b>Personalizado</b> mantém tudo o que está na tela, sem redefinir
          nada. A troca de perfil nunca altera reservas, orçamentos, cauções ou cobranças já registradas.
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {(["festas", "carretinhas"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => aplicarPerfil(p)}
              className={`rounded-xl border px-3 py-3 text-left text-sm ${
                estado.perfil === p && !sujo ? "border-marca-400 bg-marca-50" : "border-nuvem-300 bg-white"
              }`}
            >
              <span className="block font-bold text-tinta-900">{PERFIL_ROTULO[p]}</span>
              <span className="block text-xs text-stone-500">
                {p === "festas"
                  ? "Evento, endereço, montagem e caução habilitados (padrão do sistema)."
                  : "Retirada e devolução como operações; sem evento, endereço, montagem ou caução."}
              </span>
            </button>
          ))}
          <button
            type="button"
            onClick={() => aplicarPerfil("personalizado")}
            className={`rounded-xl border px-3 py-3 text-left text-sm ${
              estado.perfil === "personalizado" ? "border-marca-400 bg-marca-50" : "border-nuvem-300 bg-white"
            }`}
          >
            <span className="block font-bold text-tinta-900">{PERFIL_ROTULO.personalizado}</span>
            <span className="block text-xs text-stone-500">
              Mantém o que está na tela e grava o perfil como Personalizado, item a item.
            </span>
          </button>
        </div>
      </section>

      <form action={submitSalvar} className="space-y-4">
        {/* o perfil é dado do formulário, não só da tela: sem este campo o
            servidor recebe FormData sem op_perfil e recusa TUDO com
            "Perfil operacional inválido" (estado React não viaja sozinho) */}
        <input type="hidden" name={OPERACAO_KEYS.perfil} value={estado.perfil} />
        <section className="cartao p-4">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">Nomenclaturas</h2>
          <div className="space-y-3">
            {CAMPOS_ROTULO.map(({ chave, titulo, hint }) => (
              <div key={chave}>
                <Field label={titulo} hint={hint}>
                  <div className="flex gap-2">
                    <input
                      name={ROTULO_KEY[chave]}
                      value={estado.rotulos[chave]}
                      maxLength={TAMANHO_MAX_ROTULO}
                      onChange={(e) => editar(chave, e.target.value)}
                      className="campo flex-1"
                      placeholder={ROTULOS_PADRAO[chave]}
                    />
                    <button
                      type="button"
                      onClick={() => editar(chave, "")}
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
                  value="1"
                  checked={estado.vis[chave]}
                  onChange={(e) => alternarVis(chave, e.target.checked)}
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
            <p className="font-semibold text-tinta-900">Menu: “{tituloOperacoes(configAtual)}”</p>
            <p className="font-semibold text-tinta-900">Cliente</p>
            {estado.vis.evento && (
              <p>
                <span className="text-stone-600">{estado.rotulos.evento || ROTULOS_PADRAO.evento} · </span>
                <span className="text-stone-600">{estado.rotulos.evento_hora || ROTULOS_PADRAO.evento_hora}</span>
              </p>
            )}
            <p>
              <span className="font-semibold text-tinta-900">{estado.rotulos.inicio || ROTULOS_PADRAO.inicio}</span>
              <span className="text-stone-500"> — início da locação</span>
            </p>
            <p>
              <span className="font-semibold text-tinta-900">{estado.rotulos.fim || ROTULOS_PADRAO.fim}</span>
              <span className="text-stone-500"> — fim da locação</span>
            </p>
            <p className="text-stone-600">
              ☑ {estado.rotulos.operacao_inicio || ROTULOS_PADRAO.operacao_inicio} · ☑{" "}
              {estado.rotulos.operacao_fim || ROTULOS_PADRAO.operacao_fim}
              <span className="text-stone-500"> — checkboxes de serviços</span>
            </p>
            {estado.vis.endereco && <p className="text-stone-600">Endereço do evento (bairro, cidade)</p>}
            {estado.vis.montagem && <p className="text-stone-600">Montagem · Desmontagem</p>}
            {estado.vis.caucao && <p className="text-stone-600">Caução (R$)</p>}
            {!estado.vis.evento && <p className="text-xs text-stone-400">Campo de evento oculto — a data interna deriva do início da locação.</p>}
            {!estado.vis.endereco && <p className="text-xs text-stone-400">Endereço do evento oculto — dados já gravados são preservados.</p>}
            {!estado.vis.montagem && <p className="text-xs text-stone-400">Montagem e desmontagem ocultas — valores já lançados permanecem.</p>}
            {!estado.vis.caucao && <p className="text-xs text-stone-400">Caução oculta em novas operações — cobranças e cauções existentes não são alteradas.</p>}
          </div>
        </section>

        {mudancas.length > 0 && !salvarPendente && (
          <Alerta tone="ambar" title="Alterações ainda não salvas">
            <ul className="list-inside list-disc space-y-0.5">
              {mudancas.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
            <p className="mt-1">Nada disso vale até você salvar; reservas e orçamentos existentes não são modificados.</p>
          </Alerta>
        )}

        {estadoSalvar && !estadoSalvar.ok && (
          <Alerta tone="vermelho" title="Não foi possível salvar">
            {estadoSalvar.erro} — as alterações continuam nesta tela; corrija e salve de novo.
          </Alerta>
        )}
        {estadoSalvar?.ok && salvadoAgora && (
          <Alerta tone="verde" title="Configuração salva">
            Perfil {PERFIL_ROTULO[estado.perfil]} persistido e já valendo em todas as telas desta empresa.
          </Alerta>
        )}

        <SubmitButton disabled={restorePendente}>Salvar configuração operacional</SubmitButton>
      </form>

      <section className="cartao p-4">
        <h2 className="text-sm font-bold uppercase tracking-wide text-stone-500">Restaurar padrões</h2>
        <p className="mt-2 text-sm text-stone-500">
          Volta nomenclaturas, campos opcionais e perfil ao padrão do sistema ({PERFIL_ROTULO.festas}), sem apagar
          nenhum dado de reservas, orçamentos ou cauções.
        </p>
        {resultadoRestore?.ok && (
          <div className="mt-3">
            <Alerta tone="verde" title="Padrões restaurados">
              Os rótulos e a visibilidade voltaram ao padrão do sistema.
            </Alerta>
          </div>
        )}
        <form action={submitRestore} className="mt-3">
          <SubmitButton
            variant="secundario"
            disabled={salvarPendente}
            confirm="Restaurar os padrões da configuração operacional? Os dados gravados não serão alterados."
          >
            Restaurar valores padrão
          </SubmitButton>
        </form>
      </section>
    </div>
  );
}
