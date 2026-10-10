"use client";
import { useState, useTransition } from "react";
import { salvarIntegracaoAsaasAction, testarIntegracaoAsaasAction } from "../actions";
import type { ChavePlataforma } from "@/lib/platform-settings";

/**
 * Cadastro das credenciais do Asaas pelo próprio painel /saas (pendência de
 * ativação em produção). Antes só existiam secrets de Worker e a tela apenas
 * MOSTRAVA o estado — sem isto, ativar cobrança exigia terminal.
 *
 * Regras visíveis aqui:
 *  * valor já salvo NUNCA volta para o cliente (o campo nasce vazio; só o
 *    placeholder diz que existe) — segredo sai do servidor uma vez só;
 *  * campo vazio ao salvar = mantém o que já existe; para apagar, "Apagar";
 *  * o token de webhook é gerado aqui e mostrado UMA vez em forma de URL pronta
 *    para colar no Asaas — depois de salvo não é mais recuperável.
 */

type Origem = "worker" | "painel" | "ausente";

export type EstadoIntegracao = {
  ambiente: string | null;
  temApiKey: boolean;
  temToken: boolean;
  origem: { apiKey: Origem; environment: Origem; webhookToken: Origem };
  /** URL base pública da plataforma (para montar a URL do webhook). */
  publicUrl: string;
};

const ROTULO: Record<Origem, string> = {
  worker: "vem do secret do Worker",
  painel: "cadastrado no painel",
  ausente: "não configurado",
};

const CLASSE_BOTAO =
  "rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-60";
const CLASSE_BOTAO_PRIMARIO =
  "rounded-lg bg-marca-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-marca-700 disabled:opacity-60";

function gerarToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export default function FormAsaas({ estado }: { estado: EstadoIntegracao }) {
  const [apiKey, setApiKey] = useState("");
  const [token, setToken] = useState("");
  const [ambiente, setAmbiente] = useState(estado.ambiente ?? "");
  const [limpar, setLimpar] = useState<ChavePlataforma[]>([]);
  const [urlMontada, setUrlMontada] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [pendente, start] = useTransition();

  function salvar() {
    setMsg(null);
    start(async () => {
      const r = await salvarIntegracaoAsaasAction(
        { asaas_api_key: apiKey, asaas_environment: ambiente, asaas_webhook_token: token },
        limpar,
      );
      setMsg({ ok: r.ok, texto: r.mensagem });
      if (r.ok) {
        setApiKey("");
        setLimpar([]);
      }
    });
  }

  function testar() {
    setMsg(null);
    start(async () => {
      const r = await testarIntegracaoAsaasAction();
      setMsg({ ok: r.ok, texto: r.mensagem });
    });
  }

  function gerar() {
    const novo = gerarToken();
    setToken(novo);
    setLimpar((l) => l.filter((c) => c !== "asaas_webhook_token"));
    setUrlMontada(`${estado.publicUrl || ""}/api/webhooks/asaas?token=${novo}`);
  }

  const marcado = (c: ChavePlataforma) => limpar.includes(c);

  return (
    <div className="mt-3 space-y-3">
      {/* API key ---------------------------------------------------------------- */}
      <div>
        <label className="rotulo">Token de API do Asaas (access_token)</label>
        <input
          type="password"
          className="campo"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            estado.temApiKey
              ? `•••••••• (${ROTULO[estado.origem.apiKey]}) — digite para substituir`
              : "ex.: $aact_prod_xxxxxxxx…"
          }
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            if (e.target.value) setLimpar((l) => l.filter((c) => c !== "asaas_api_key"));
          }}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="text-xs text-stone-500">
            Painel Asaas → Seu perfil → API. No ambiente {estado.ambiente ?? "?"} use a chave daquele ambiente.
          </p>
          {estado.temApiKey && (
            <button
              type="button"
              className={CLASSE_BOTAO}
              onClick={() => setLimpar((l) => (marcado("asaas_api_key") ? l.filter((c) => c !== "asaas_api_key") : [...l, "asaas_api_key"]))}
            >
              {marcado("asaas_api_key") ? "Cancelar remoção" : "Apagar"}
            </button>
          )}
        </div>
        {marcado("asaas_api_key") && (
          <p className="text-xs font-semibold text-red-700">Vai ser apagada ao salvar.</p>
        )}
      </div>

      {/* Ambiente --------------------------------------------------------------- */}
      <div>
        <label className="rotulo">Ambiente</label>
        <select
          className="campo"
          value={ambiente}
          onChange={(e) => setAmbiente(e.target.value)}
        >
          <option value="">— não definido —</option>
          <option value="production">production (cobrança real)</option>
          <option value="sandbox">sandbox (pagamentos simulados)</option>
        </select>
        <p className="mt-1 text-xs text-stone-500">
          Origem atual: {ROTULO[estado.origem.environment]}.
        </p>
      </div>

      {/* Token do webhook ------------------------------------------------------- */}
      <div>
        <label className="rotulo">Token do webhook</label>
        <input
          type="text"
          className="campo font-mono"
          autoComplete="off"
          spellCheck={false}
          placeholder={
            estado.temToken
              ? `•••••••• (${ROTULO[estado.origem.webhookToken]}) — gere um novo para substituir`
              : "gere um novo ou cole o que você já usa"
          }
          value={token}
          onChange={(e) => {
            setToken(e.target.value);
            setUrlMontada(null);
            if (e.target.value) setLimpar((l) => l.filter((c) => c !== "asaas_webhook_token"));
          }}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <p className="text-xs text-stone-500">
            Comparado em tempo constante com <code className="rounded bg-stone-100 px-1">?token=</code> na URL do webhook.
          </p>
          <div className="flex gap-2">
            {estado.temToken && (
              <button
                type="button"
                className={CLASSE_BOTAO}
                onClick={() =>
                  setLimpar((l) =>
                    marcado("asaas_webhook_token")
                      ? l.filter((c) => c !== "asaas_webhook_token")
                      : [...l, "asaas_webhook_token"],
                  )
                }
              >
                {marcado("asaas_webhook_token") ? "Cancelar remoção" : "Apagar"}
              </button>
            )}
            <button type="button" className={CLASSE_BOTAO} onClick={gerar}>
              Gerar novo
            </button>
          </div>
        </div>
        {marcado("asaas_webhook_token") && (
          <p className="text-xs font-semibold text-red-700">Vai ser apagado ao salvar.</p>
        )}
        {urlMontada && (
          <div className="mt-2 rounded-lg border border-stone-200 bg-stone-50 p-2">
            <p className="text-xs font-semibold text-tinta-900">
              URL do webhook — copie para o painel do Asaas (Integrações → Webhook). Ela não volta a ser exibida.
            </p>
            <code className="mt-1 block break-all rounded bg-white p-2 text-xs text-stone-700">{urlMontada}</code>
            <button
              type="button"
              className={`${CLASSE_BOTAO} mt-2`}
              onClick={() => {
                void navigator.clipboard?.writeText(urlMontada);
                setMsg({ ok: true, texto: "URL copiada." });
              }}
            >
              Copiar URL
            </button>
          </div>
        )}
      </div>

      {/* Ações ------------------------------------------------------------------ */}
      <div className="flex flex-wrap items-center gap-2 border-t border-stone-200 pt-3">
        <button type="button" className={CLASSE_BOTAO_PRIMARIO} onClick={salvar} disabled={pendente}>
          {pendente ? "…" : "Salvar"}
        </button>
        <button type="button" className={CLASSE_BOTAO} onClick={testar} disabled={pendente}>
          Testar credencial no Asaas
        </button>
        {msg && (
          <span className={`text-xs font-semibold ${msg.ok ? "text-green-700" : "text-red-700"}`}>
            {msg.texto}
          </span>
        )}
      </div>
    </div>
  );
}
