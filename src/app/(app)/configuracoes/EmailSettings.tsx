"use client";
import { useState, useActionState } from "react";
import Link from "next/link";
import { Alerta, Field, Grid } from "@/components/ui";
import { SubmitButton } from "@/components/SubmitButton";
import {
  avisosDeConfiguracao,
  GRUPOS_EMAIL,
  MAX_ANTECEDENCIAS,
  TIPOS_DO_GRUPO,
  TIPOS_EMAIL,
  type ConfigEmail,
  type GrupoEmail,
  type TipoEmail,
} from "@/lib/email-notificacoes";
import { saveEmailSettings, sendTestEmail, type ResultadoEmailSave } from "./actions";

type Linha = { valor: number; unidade: "min" | "hora" | "dia" };

/** Rótulo/descrição de cada tipo, direto do catálogo compartilhado. */
const TIPOS_EMAIL_LABEL = TIPOS_EMAIL;

const PARA_MINUTOS = (l: Linha) =>
  Math.max(0, l.valor) * (l.unidade === "dia" ? 1440 : l.unidade === "hora" ? 60 : 1);

function deMinutos(minutos: number): Linha {
  if (minutos % 1440 === 0) return { valor: minutos / 1440, unidade: "dia" };
  if (minutos % 60 === 0) return { valor: minutos / 60, unidade: "hora" };
  return { valor: minutos, unidade: "min" };
}

/**
 * Configuração de e-mails automáticos POR EMPRESA
 * (Configurações > Notificações > E-mails).
 *
 * Pontos que esta tela garante para um usuário não técnico:
 *  - cada aviso liga/desliga sozinho, com descrição do que dispara;
 *  - antecedência dos lembretes digitada em minutos/dias (não há intervalo
 *    fixo no código), com validação no servidor;
 *  - resumo do que está desligado ou incompleto, visível antes de salvar;
 *  - e-mail de teste imediato, sem usar dados reais de cliente;
 *  - os dados comerciais vêm de Configurações > Empresa e são mostrados aqui
 *    em leitura, para conferir o que o cliente receberá.
 */
export default function EmailSettings({
  inicial,
  admin,
  emailConfigurado,
  temFidelidade,
}: {
  inicial: ConfigEmail;
  admin: boolean;
  emailConfigurado: boolean;
  temFidelidade: boolean;
}) {
  const [resultado, submit] = useActionState<ResultadoEmailSave | null, FormData>(saveEmailSettings, null);

  const [ativo, setAtivo] = useState(inicial.ativo);
  const [grupos, setGrupos] = useState(inicial.grupos);
  const [tipos, setTipos] = useState(inicial.tipos);
  const [antecReserva, setAntecReserva] = useState<Linha[]>(inicial.antecedenciaReserva.map(deMinutos));
  const [antecOperacao, setAntecOperacao] = useState<Linha[]>(inicial.antecedenciaOperacao.map(deMinutos));
  const [destino, setDestino] = useState("");

  const resumo: ConfigEmail = { ...inicial, ativo, grupos, tipos };
  const avisos = avisosDeConfiguracao(resumo, emailConfigurado);

  const interruptor = (chave: string, valor: boolean, set: (v: boolean) => void, rotulo: string, descricao?: string) => (
    <label className="flex items-start gap-3 py-1.5 text-sm">
      <input
        type="hidden"
        name={chave}
        value={valor ? "1" : "0"}
      />
      <input
        type="checkbox"
        checked={valor}
        onChange={(e) => set(e.target.checked)}
        disabled={!admin}
        className="mt-0.5 h-4 w-4"
      />
      <span>
        <b>{rotulo}</b>
        {descricao && <span className="block text-xs font-normal text-stone-500">{descricao}</span>}
      </span>
    </label>
  );

  const antecedencias = (
    titulo: string,
    campo: string,
    linhas: Linha[],
    set: (l: Linha[]) => void,
  ) => (
    <div className="mt-3 rounded-xl border border-nuvem-300 p-3">
      <p className="mb-2 text-xs font-bold uppercase tracking-wide text-stone-500">{titulo}</p>
      {linhas.map((l, i) => (
        <div key={i} className="mb-2 flex flex-wrap items-center gap-2 text-sm">
          <input
            type="number"
            min={1}
            max={999}
            value={l.valor}
            disabled={!admin}
            onChange={(e) => {
              const copia = [...linhas];
              copia[i] = { ...l, valor: Math.max(0, Number(e.target.value) || 0) };
              set(copia);
            }}
            className="campo w-24"
            aria-label={`Antecedência ${i + 1}`}
          />
          <select
            value={l.unidade}
            disabled={!admin}
            onChange={(e) => {
              const copia = [...linhas];
              copia[i] = { ...l, unidade: e.target.value as Linha["unidade"] };
              set(copia);
            }}
            className="campo w-32"
            aria-label={`Unidade ${i + 1}`}
          >
            <option value="min">minuto(s)</option>
            <option value="hora">hora(s)</option>
            <option value="dia">dia(s)</option>
          </select>
          <button
            type="button"
            disabled={!admin || linhas.length <= 1}
            onClick={() => set(linhas.filter((_, j) => j !== i))}
            className="text-xs text-stone-500 underline"
          >
            remover
          </button>
        </div>
      ))}
      {linhas.length < MAX_ANTECEDENCIAS && (
        <button
          type="button"
          disabled={!admin}
          onClick={() => set([...linhas, { valor: 1, unidade: "dia" }])}
          className="text-sm text-marca-600 underline"
        >
          + adicionar lembrete
        </button>
      )}
      {/* valores convertidos para minutos no próprio formulário */}
      {linhas
        .filter((l) => l.valor > 0)
        .map((l, i) => (
          <input key={`v${i}`} type="hidden" name={campo} value={PARA_MINUTOS(l)} />
        ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <section className="cartao p-4">
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-stone-500">E-mails para os clientes</h2>
        <p className="mb-3 text-sm text-stone-600">
          Avisos transacionais enviados no lugar da locadora: reservas, entregas, retiradas e fidelidade. Não há
          marketing em massa — quem recebe é o cliente da reserva ou do programa, com os dados desta empresa.
        </p>
        {interruptor(
          "email_enabled",
          ativo,
          setAtivo,
          "Ativar e-mails automáticos",
          "Interruptor geral. Desligado, nenhum aviso é enviado, mesmo que os tipos abaixo estejam marcados.",
        )}
        {!ativo && (
          <Alerta tone="ambar">
            E-mails automáticos desativados: nada é enviado até que o interruptor geral seja ligado.
          </Alerta>
        )}
      </section>

      {avisos.length > 0 && (
        <Alerta tone="ambar">
          <b>Pontos de atenção:</b>
          <ul className="mt-1 list-inside list-disc">
            {avisos.map((a) => (
              <li key={a.chave}>{a.texto}</li>
            ))}
          </ul>
        </Alerta>
      )}
      {resultado && !resultado.ok && <Alerta tone="vermelho">{resultado.erro}</Alerta>}
      {resultado && resultado.ok && <Alerta tone="verde">Configuração de e-mails salva.</Alerta>}

      <form action={submit} className="space-y-4">
        <section className="cartao p-4">
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">
            Reservas
          </h3>
          <p className="mb-2 text-xs text-stone-500">{GRUPOS_EMAIL.reservas.descricao}</p>
          {interruptor(
            "email_grupo_reservas",
            grupos.reservas,
            (v) => setGrupos({ ...grupos, reservas: v }),
            "Ativar o grupo Reservas",
          )}
          <div className="mt-2 border-t border-nuvem-200 pt-2">
            {TIPOS_DO_GRUPO("reservas")
              .filter((t) => t !== "email_teste")
              .map((t) => (
                <div key={t}>
                  {interruptor(`email_${t}`, tipos[t], (v) => setTipos({ ...tipos, [t]: v }), TIPOS_EMAIL_LABEL[t].rotulo, TIPOS_EMAIL_LABEL[t].descricao)}
                </div>
              ))}
          </div>
          {antecedencias(
            "Antecedências do lembrete de reserva",
            "antec_reserva",
            antecReserva,
            setAntecReserva,
          )}
        </section>

        <section className="cartao p-4">
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">
            Entregas e retiradas
          </h3>
          <p className="mb-2 text-xs text-stone-500">{GRUPOS_EMAIL.operacoes.descricao}</p>
          {interruptor(
            "email_grupo_operacoes",
            grupos.operacoes,
            (v) => setGrupos({ ...grupos, operacoes: v }),
            "Ativar o grupo de operações",
          )}
          <div className="mt-2 border-t border-nuvem-200 pt-2">
            {TIPOS_DO_GRUPO("operacoes").map((t) => (
              <div key={t}>
                {interruptor(`email_${t}`, tipos[t], (v) => setTipos({ ...tipos, [t]: v }), TIPOS_EMAIL_LABEL[t].rotulo, TIPOS_EMAIL_LABEL[t].descricao)}
              </div>
            ))}
          </div>
          {antecedencias(
            "Antecedências do lembrete de operação",
            "antec_operacao",
            antecOperacao,
            setAntecOperacao,
          )}
          <p className="mt-2 text-xs text-stone-500">
            Os rótulos acompanham a configuração operacional da empresa: um perfil de retirada e devolução vê
            &quot;Retirada&quot; e &quot;Devolução&quot; — nunca mensagens de entrega.
          </p>
        </section>

        {temFidelidade && (
          <section className="cartao p-4">
            <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">
              Programa de fidelidade
            </h3>
            <p className="mb-2 text-xs text-stone-500">{GRUPOS_EMAIL.fidelidade.descricao}</p>
            {interruptor(
              "email_grupo_fidelidade",
              grupos.fidelidade,
              (v) => setGrupos({ ...grupos, fidelidade: v }),
              "Ativar o grupo Fidelidade",
            )}
            <div className="mt-2 border-t border-nuvem-200 pt-2">
              {TIPOS_DO_GRUPO("fidelidade").map((t) => (
                <div key={t}>
                  {interruptor(`email_${t}`, tipos[t], (v) => setTipos({ ...tipos, [t]: v }), TIPOS_EMAIL_LABEL[t].rotulo, TIPOS_EMAIL_LABEL[t].descricao)}
                </div>
              ))}
            </div>
            <div className="mt-3">
              <Field
                label="Proximidade da recompensa"
                hint="Avisar quando faltar esta quantidade para a meta. Padrão: 1."
              >
                <input
                  type="number"
                  name="email_fidelidade_quase_la_limite"
                  min={1}
                  max={999}
                  defaultValue={inicial.quaseLaLimite}
                  disabled={!admin}
                  className="campo w-32"
                />
              </Field>
            </div>
          </section>
        )}

        <section className="cartao p-4">
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">
            Preferências gerais
          </h3>
          <Grid>
            <Field label="Hora mínima de envio" hint="Nenhum lembrete sai antes deste horário (fuso abaixo).">
              <input
                type="time"
                name="email_hora_envio"
                defaultValue={inicial.horaEnvio}
                disabled={!admin}
                className="campo"
              />
            </Field>
            <Field label="Fuso horário" hint="Usado nos agendamentos dos lembretes. IANA (ex.: America/Sao_Paulo).">
              <input
                name="email_fuso"
                defaultValue={inicial.fuso}
                disabled={!admin}
                maxLength={60}
                className="campo"
              />
            </Field>
            <Field label="Cor de destaque" hint="Cor dos botões e da identidade nos e-mails (#RRGGBB).">
              <input
                type="color"
                name="email_cor"
                defaultValue={inicial.cor}
                disabled={!admin}
                className="h-10 w-24 cursor-pointer rounded border border-nuvem-300 bg-white p-1"
              />
            </Field>
          </Grid>
          <div className="mt-3">
            <Field
              label="Orientações comerciais"
              hint="Texto fixo exibido no rodapé dos e-mails (ex.: horário de atendimento, regras de retirada)."
            >
              <textarea
                name="email_instrucoes"
                defaultValue={inicial.instrucoes}
                disabled={!admin}
                rows={3}
                maxLength={500}
                className="campo"
              />
            </Field>
          </div>
        </section>

        <section className="cartao p-4">
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-stone-500">
            Dados comerciais usados nos e-mails
          </h3>
          <p className="mb-2 text-sm text-stone-600">
            Nome, logo, telefone, WhatsApp, endereço e cidade vêm de{" "}
            <Link href="/configuracoes?aba=empresa" className="text-marca-600 underline">
              Configurações &gt; Empresa
            </Link>
            . Confira antes de ativar: é esta identidade que o cliente vê.
          </p>
          <ul className="list-inside list-disc text-sm text-stone-600">
            <li>Remetente: conta do provedor configurada no Worker (domínio verificado).</li>
            <li>O nome exibido como remetente é o nome comercial desta empresa.</li>
          </ul>
        </section>

        {admin ? (
          <SubmitButton>Salvar configuração de e-mails</SubmitButton>
        ) : (
          <Alerta tone="ambar">Apenas o administrador pode alterar a configuração de e-mails.</Alerta>
        )}
      </form>

      <section className="cartao p-4">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-stone-500">E-mail de teste</h3>
        <p className="mb-3 text-sm text-stone-600">
          Envia o modelo com dados fictícios (nenhum cliente real é consultado e nenhuma reserva é criada). Funciona
          mesmo com os interruptores desligados — é a forma de conferir remetente, identidade e visual antes de ativar.
        </p>
        <form action={sendTestEmail} className="flex flex-wrap items-end gap-3">
          <Field label="Destinatário do teste">
            <input
              type="email"
              name="destino"
              required
              value={destino}
              onChange={(e) => setDestino(e.target.value)}
              placeholder="seu@email.com"
              className="campo w-72 max-w-full"
            />
          </Field>
          <SubmitButton variant="secundario">Enviar teste</SubmitButton>
        </form>
      </section>

      <section className="cartao p-4">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-stone-500">Histórico de envios</h3>
        <p className="text-sm text-stone-600">
          Cada aviso enviado, cancelado ou recusado fica registrado — com destinatário, tentativas e motivo.{" "}
          <Link href="/notificacoes/emails" className="text-marca-600 underline">
            Abrir histórico de e-mails
          </Link>
        </p>
      </section>
    </div>
  );
}
