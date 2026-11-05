"use client";
/**
 * Editor de modelos de e-mail — Configurações > Notificações > E-mails.
 *
 * Pensado para quem NÃO é técnico:
 *  - escolhe o aviso na lista (o mesmo nome que aparece nas notificações);
 *  - todos os campos começam com o texto que já está configurado e vazio
 *    significa "usar o texto original";
 *  - a biblioteca de variáveis mostra o que cada uma significa, deixa inserir
 *    no campo em foco e copiar;
 *  - variável que não existe naquele aviso é avisada ANTES de salvar;
 *  - pré-visualização com a logo e o rodapé reais, com dados fictícios ou de
 *    uma reserva escolhida, e envio de teste que não dispara nada operacional;
 *  - cada aviso é salvo individualmente, e há restauração do texto original.
 */
import Link from "next/link";
import { useActionState, useMemo, useRef, useState } from "react";
import { Alerta, Field } from "@/components/ui";
import { TIPOS_EMAIL, type TipoEmail } from "@/lib/email-notificacoes";
import { CAMPOS_MODELO, resumoModelo, type CampoModelo, type ModeloEmail } from "@/lib/email-modelos";
import {
  GRUPOS_VARIAVEIS,
  chavesDoTipo,
  chavesInvalidas,
  variaveisDoTipo,
  type GrupoVariavel,
} from "@/lib/email-variaveis";
import { enviarModeloTesteAction, modeloEmailAction, type ResultadoModeloAcao } from "./email-modelos-actions";

type ReservaOpcao = { id: number; rotulo: string };

const TIPOS = Object.keys(TIPOS_EMAIL) as TipoEmail[];

function agrupar(tipo: TipoEmail) {
  const variaveis = variaveisDoTipo(tipo);
  const grupos = (Object.keys(GRUPOS_VARIAVEIS) as GrupoVariavel[]).filter((g) => variaveis.some((v) => v.grupo === g));
  return { variaveis, grupos };
}

export default function ModelosEmail({
  modelos,
  admin,
  reservas,
}: {
  modelos: Record<TipoEmail, ModeloEmail>;
  admin: boolean;
  reservas: ReservaOpcao[];
}) {
  const [tipo, setTipo] = useState<TipoEmail>("reserva_confirmacao");
  const [draft, setDraft] = useState<ModeloEmail>(modelos.reserva_confirmacao ?? {});
  const [campoAtivo, setCampoAtivo] = useState<CampoModelo>("corpo");
  const [copiado, setCopiado] = useState<string | null>(null);
  const [reservaId, setReservaId] = useState<string>("");
  const [destino, setDestino] = useState("");

  const refs = useRef<Record<string, HTMLTextAreaElement | HTMLInputElement | null>>({});

  const [estado, salvar, salvando] = useActionState<ResultadoModeloAcao | null, FormData>(modeloEmailAction, null);
  const [teste, enviarTeste, enviandoTeste] = useActionState<ResultadoModeloAcao | null, FormData>(
    enviarModeloTesteAction,
    null,
  );

  const { variaveis, grupos } = useMemo(() => agrupar(tipo), [tipo]);
  const permitidas = useMemo(() => chavesDoTipo(tipo), [tipo]);
  const invalidas = useMemo(
    () => chavesInvalidas(CAMPOS_MODELO.map((c) => draft[c.chave] ?? "").join("\n"), permitidas),
    [draft, permitidas],
  );

  function trocarTipo(novo: TipoEmail) {
    setTipo(novo);
    setDraft(modelos[novo] ?? {});
    setCampoAtivo("corpo");
    setCopiado(null);
  }

  function definir(campo: CampoModelo, valor: string) {
    setDraft((atual) => ({ ...atual, [campo]: valor }));
  }

  /** Insere a variável no ponto do cursor do último campo focado. */
  function inserir(chave: string) {
    const token = `{{${chave}}}`;
    const el = refs.current[campoAtivo];
    const texto = draft[campoAtivo] ?? "";
    const ini = el?.selectionStart ?? texto.length;
    const fim = el?.selectionEnd ?? texto.length;
    definir(campoAtivo, texto.slice(0, ini) + token + texto.slice(fim));
    requestAnimationFrame(() => {
      el?.focus();
      try {
        el?.setSelectionRange(ini + token.length, ini + token.length);
      } catch {
        // input sem seleção (ex.: type=text em alguns navegadores) — ignora
      }
    });
  }

  async function copiar(chave: string) {
    try {
      await navigator.clipboard.writeText(`{{${chave}}}`);
      setCopiado(chave);
      setTimeout(() => setCopiado((v) => (v === chave ? null : v)), 1800);
    } catch {
      setCopiado(null);
    }
  }

  const mensagem = estado?.ok ? estado.mensagem : estado?.erro;
  const mensagemTeste = teste?.ok ? teste.mensagem : teste?.erro;

  return (
    <div className="space-y-4">
      <div className="cartao p-4">
        <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-stone-500">Modelos de e-mail</h3>
        <p className="mb-3 text-sm text-stone-600">
          Personalize o que o cliente lê em cada aviso. Deixe um campo em branco para manter o texto original — nada é
          obrigatório, e o botão de restaurar devolve o modelo padrão.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Aviso" hint={`${resumoModelo(draft)} neste aviso.`}>
            <select
              value={tipo}
              onChange={(e) => trocarTipo(e.target.value as TipoEmail)}
              className="campo"
              aria-label="Tipo de e-mail"
            >
              {TIPOS.map((t) => (
                <option key={t} value={t}>
                  {TIPOS_EMAIL[t].rotulo}
                </option>
              ))}
            </select>
          </Field>
          <div className="text-sm text-stone-600">
            <p className="font-semibold text-tinta-900">{TIPOS_EMAIL[tipo].rotulo}</p>
            <p>{TIPOS_EMAIL[tipo].descricao}</p>
          </div>
        </div>
      </div>

      {mensagem && <Alerta tone={estado?.ok ? "verde" : "vermelho"}>{mensagem}</Alerta>}
      {mensagemTeste && <Alerta tone={teste?.ok ? "verde" : "vermelho"}>{mensagemTeste}</Alerta>}
      {invalidas.length > 0 && (
        <Alerta tone="ambar">
          <b>Variáveis indisponíveis neste aviso:</b>{" "}
          {invalidas.map((v) => `{{${v}}}`).join(", ")}. Elas sairiam vazias no envio — remova ou escolha uma da lista
          ao lado.
        </Alerta>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ------------------------------- editor ------------------------------ */}
        <form action={salvar} className="cartao space-y-4 p-4">
          <input type="hidden" name="tipo" value={tipo} />
          <input type="hidden" name="acao" value="salvar" />

          {CAMPOS_MODELO.map((campo) =>
            campo.multilinha ? (
              <Field key={campo.chave} label={campo.rotulo} hint={`${campo.descricao} Máximo ${campo.max} caracteres.`}>
                <textarea
                  id={`modelo-${campo.chave}`}
                  name={`modelo_${campo.chave}`}
                  ref={(el) => {
                    refs.current[campo.chave] = el;
                  }}
                  value={draft[campo.chave] ?? ""}
                  onChange={(e) => definir(campo.chave, e.target.value)}
                  onFocus={() => setCampoAtivo(campo.chave)}
                  disabled={!admin}
                  rows={campo.chave === "corpo" ? 8 : 3}
                  maxLength={campo.max}
                  placeholder={campo.exemplo}
                  className="campo"
                />
              </Field>
            ) : (
              <Field key={campo.chave} label={campo.rotulo} hint={`${campo.descricao} Máximo ${campo.max} caracteres.`}>
                <input
                  id={`modelo-${campo.chave}`}
                  name={`modelo_${campo.chave}`}
                  ref={(el) => {
                    refs.current[campo.chave] = el;
                  }}
                  value={draft[campo.chave] ?? ""}
                  onChange={(e) => definir(campo.chave, e.target.value)}
                  onFocus={() => setCampoAtivo(campo.chave)}
                  disabled={!admin}
                  maxLength={campo.max}
                  placeholder={campo.exemplo}
                  className="campo"
                />
              </Field>
            ),
          )}

          <p className="rounded-lg bg-nuvem-100 px-3 py-2 text-xs text-stone-600">
            Linha em branco separa parágrafos. Os dados do evento (data, itens, valor) continuam vindo do sistema — o
            texto é seu, a informação é sempre a atual.
          </p>

          {admin ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="submit"
                name="acao"
                value="salvar"
                disabled={salvando}
                className="rounded-xl bg-marca-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {salvando ? "Salvando…" : "Salvar este modelo"}
              </button>
              <button
                type="submit"
                name="acao"
                value="previa"
                disabled={salvando}
                className="rounded-xl border border-nuvem-300 px-4 py-2 text-sm font-semibold disabled:opacity-60"
              >
                {salvando ? "Gerando…" : "Pré-visualizar"}
              </button>
              <button
                type="submit"
                name="acao"
                value="restaurar"
                disabled={salvando}
                className="rounded-xl border border-nuvem-300 px-4 py-2 text-sm font-semibold text-stone-600 disabled:opacity-60"
              >
                Restaurar modelo original
              </button>
            </div>
          ) : (
            <Alerta tone="ambar">Apenas o administrador pode alterar os modelos de e-mail.</Alerta>
          )}
        </form>

        {/* ---------------------------- variáveis ----------------------------- */}
        <aside className="cartao h-fit p-4 lg:sticky lg:top-4">
          <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-stone-500">Variáveis disponíveis</h3>
          <p className="mb-3 text-xs text-stone-500">
            Clique em <b>inserir</b> para adicionar no campo em foco ({CAMPOS_MODELO.find((c) => c.chave === campoAtivo)?.rotulo.toLowerCase()}).
          </p>
          <div className="max-h-[520px] space-y-3 overflow-y-auto pr-1">
            {grupos.map((g) => (
              <div key={g}>
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-stone-500">{GRUPOS_VARIAVEIS[g].rotulo}</p>
                <p className="mb-2 text-xs text-stone-500">{GRUPOS_VARIAVEIS[g].descricao}</p>
                <ul className="space-y-2">
                  {variaveis
                    .filter((v) => v.grupo === g)
                    .map((v) => (
                      <li key={v.chave} className="rounded-lg border border-nuvem-200 px-2.5 py-2">
                        <code className="text-xs font-semibold text-tinta-900">{`{{${v.chave}}}`}</code>
                        <p className="mt-0.5 text-xs text-stone-600">{v.descricao}</p>
                        <div className="mt-1.5 flex flex-wrap gap-2 text-xs">
                          <button
                            type="button"
                            onClick={() => inserir(v.chave)}
                            disabled={!admin}
                            className="text-marca-600 underline disabled:opacity-50"
                          >
                            inserir
                          </button>
                          <button type="button" onClick={() => copiar(v.chave)} className="text-stone-500 underline">
                            {copiado === v.chave ? "copiado!" : "copiar"}
                          </button>
                        </div>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {/* ----------------------------- prévia + teste ------------------------- */}
      <section className="cartao space-y-4 p-4">
        <div>
          <h3 className="mb-1 text-sm font-bold uppercase tracking-wide text-stone-500">Pré-visualização</h3>
          <p className="text-sm text-stone-600">
            Mostra o e-mail com a logo, o rodapé e as variáveis já substituídas. Escolha uma reserva da empresa para ver
            os dados reais, ou deixe em branco para usar os dados de demonstração.
          </p>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <Field label="Dados da prévia" hint="Somente leitura: nenhum e-mail é enviado ao pré-visualizar.">
            <select value={reservaId} onChange={(e) => setReservaId(e.target.value)} className="campo w-72 max-w-full">
              <option value="">Dados de demonstração</option>
              {reservas.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.rotulo}
                </option>
              ))}
            </select>
          </Field>
        </div>

        {estado?.html ? (
          <div className="space-y-2">
            <p className="text-xs text-stone-500">
              Assunto: <b className="text-tinta-900">{estado.assunto}</b>
            </p>
            <iframe
              title="Pré-visualização do e-mail"
              srcDoc={estado.html}
              sandbox=""
              className="h-[620px] w-full rounded-xl border border-nuvem-300 bg-white"
            />
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-nuvem-300 bg-nuvem-50 px-4 py-6 text-center text-sm text-stone-500">
            Clique em <b>Pré-visualizar</b> para montar o e-mail.
          </p>
        )}

        <form action={enviarTeste} className="space-y-3 border-t border-nuvem-200 pt-4">
          {/* O rascunho inteiro é reenviado: o teste usa exatamente o que está na tela. */}
          <input type="hidden" name="tipo" value={tipo} />
          <input type="hidden" name="acao" value="teste" />
          {CAMPOS_MODELO.map((c) => (
            <input key={c.chave} type="hidden" name={`modelo_${c.chave}`} value={draft[c.chave] ?? ""} />
          ))}

          <div className="flex flex-wrap items-end gap-3">
            <Field label="Enviar teste para" hint="Usa dados fictícios: não dispara reserva, pagamento nem operação.">
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
            <button
              type="submit"
              disabled={!admin || enviandoTeste}
              className="rounded-xl border border-nuvem-300 px-4 py-2 text-sm font-semibold disabled:opacity-60"
            >
              {enviandoTeste ? "Enviando…" : "Enviar teste"}
            </button>
          </div>
        </form>
      </section>

      <p className="text-sm text-stone-500">
        <Link href="/configuracoes?aba=notificacoes" className="text-marca-600 underline">
          Voltar para Notificações
        </Link>{" "}
        ·{" "}
        <Link href="/notificacoes/emails" className="text-marca-600 underline">
          Ver histórico de envios
        </Link>
      </p>
    </div>
  );
}
