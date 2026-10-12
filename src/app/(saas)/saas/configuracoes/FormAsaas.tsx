"use client";
import { useState, useTransition } from "react";
import { salvarIntegracaoAsaasAction, testarIntegracaoAsaasAction } from "../actions";
import type { ChavePlataforma } from "@/lib/platform-settings";

/**
 * Cadastro das credenciais do Asaas pelo próprio painel /saas.
 *
 * Regras visíveis aqui:
 *  * valor já salvo NUNCA volta para o cliente (o campo nasce vazio; só o
 *    placeholder diz que existe) — o segredo sai do servidor uma vez só;
 *  * campo vazio ao salvar = mantém o que já existe; para apagar, "Apagar";
 *  * o token de webhook é gerado aqui e mostrado UMA vez em forma de URL pronta
 *    para colar no Asaas — depois de salvo não é mais recuperável.
 *
 * SOBRE O TRAVAMENTO (por que existe):
 * a leitura tem prioridade secret do Worker > cadastro do painel (ver
 * src/lib/platform-settings.ts). Quando o secret existe, o que estiver salvo
 * no painel é IGNORADO em runtime. Isso já causou confusão real: o operador
 * gravava "production" no formulário e o sistema seguia em sandbox, porque o
 * secret ASAAS_ENVIRONMENT valia sandbox — sem nenhum aviso de que a fonte
 * ativa era outra. Então o campo nasce TRAVADO nesse caso, com o motivo e o
 * comando para destravá-lo, em vez de aceitar digitação que não vai valer.
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

/** Nome do secret que trava cada campo — é o que o operador tem que remover. */
const SECRET_DO_CAMPO: Record<"apiKey" | "environment" | "webhookToken", string> = {
  apiKey: "ASAAS_API_KEY",
  environment: "ASAAS_ENVIRONMENT",
  webhookToken: "ASAAS_WEBHOOK_TOKEN",
};

const CLASSE_BOTAO =
  "rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-60";
const CLASSE_BOTAO_PRIMARIO =
  "rounded-lg bg-marca-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-marca-700 disabled:opacity-60";
const CLASSE_CAMPO_TRAVADO = "campo cursor-not-allowed bg-stone-100 text-stone-500";

function gerarToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return `whsec_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Aviso por campo quando o secret do Worker está vencendo o cadastro. */
function AvisoTravado({ secret }: { secret: string }) {
  return (
    <p className="mt-1 rounded-lg border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
      <span className="font-bold">Este campo está travado.</span> O valor ativo vem do secret{" "}
      <code className="rounded bg-amber-100 px-1 font-mono">{secret}</code> do Worker, que tem prioridade — o que
      você salvar aqui seria <span className="font-semibold">ignorado</span>. Para editar aqui, remova o secret:{" "}
      <code className="rounded bg-amber-100 px-1 font-mono">npx wrangler secret delete {secret} --env production</code>
    </p>
  );
}

/** Etiqueta compacta de origem, ao lado do rótulo do campo. */
function EtiquetaOrigem({ origem }: { origem: Origem }) {
  if (origem === "ausente") return null;
  const estilo =
    origem === "worker"
      ? "border-amber-300 bg-amber-50 text-amber-800"
      : "border-green-300 bg-green-50 text-green-800";
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${estilo}`}>
      {origem === "worker" ? "🔒 secret do Worker" : "✓ painel"}
    </span>
  );
}

export default function FormAsaas({ estado }: { estado: EstadoIntegracao }) {
  const [apiKey, setApiKey] = useState("");
  const [token, setToken] = useState("");
  const [ambiente, setAmbiente] = useState(estado.ambiente ?? "");
  const [limpar, setLimpar] = useState<ChavePlataforma[]>([]);
  const [urlMontada, setUrlMontada] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [pendente, start] = useTransition();

  const travaApiKey = estado.origem.apiKey === "worker";
  const travaAmbiente = estado.origem.environment === "worker";
  const travaToken = estado.origem.webhookToken === "worker";
  const camposTravados = ([
    ["apiKey", travaApiKey],
    ["environment", travaAmbiente],
    ["webhookToken", travaToken],
  ] as const).filter(([, travado]) => travado);

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
        setToken("");
        setLimpar([]);
        setUrlMontada(null);
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
      {/* Aviso consolidado: a armadilha que motivou este travamento --------- */}
      {camposTravados.length > 0 && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900">
          <p className="font-bold">
            {camposTravados.length === 1 ? "Um campo está" : `${camposTravados.length} campos estão`} sendo definidos
            pelo secret do Worker, não pelo painel.
          </p>
          <p className="mt-1">
            Enquanto esses secrets existirem, o cadastro feito aqui é <span className="font-semibold">ignorado</span> —
            o secret tem prioridade na leitura. Os campos abaixo ficam travados nesse caso.
          </p>
        </div>
      )}

      {/* API key ---------------------------------------------------------------- */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <label className="rotulo">Token de API do Asaas (access_token)</label>
          <EtiquetaOrigem origem={estado.origem.apiKey} />
        </div>
        <input
          type="password"
          className={travaApiKey ? CLASSE_CAMPO_TRAVADO : "campo"}
          disabled={travaApiKey}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            travaApiKey
              ? "definido pelo secret do Worker"
              : estado.temApiKey
                ? `•••••••• (${ROTULO[estado.origem.apiKey]}) — digite para substituir`
                : "ex.: $aact_prod_xxxxxxxx…"
          }
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.target.value);
            if (e.target.value) setLimpar((l) => l.filter((c) => c !== "asaas_api_key"));
          }}
        />
        {travaApiKey ? (
          <AvisoTravado secret={SECRET_DO_CAMPO.apiKey} />
        ) : (
          <>
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="text-xs text-stone-500">
                Painel Asaas → Seu perfil → API. No ambiente {estado.ambiente ?? "?"} use a chave daquele ambiente.
              </p>
              {estado.temApiKey && (
                <button
                  type="button"
                  className={CLASSE_BOTAO}
                  onClick={() =>
                    setLimpar((l) =>
                      marcado("asaas_api_key") ? l.filter((c) => c !== "asaas_api_key") : [...l, "asaas_api_key"],
                    )
                  }
                >
                  {marcado("asaas_api_key") ? "Cancelar remoção" : "Apagar"}
                </button>
              )}
            </div>
            {marcado("asaas_api_key") && (
              <p className="text-xs font-semibold text-red-700">Vai ser apagada ao salvar.</p>
            )}
          </>
        )}
      </div>

      {/* Ambiente --------------------------------------------------------------- */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <label className="rotulo">Ambiente</label>
          <EtiquetaOrigem origem={estado.origem.environment} />
        </div>
        <select
          className={travaAmbiente ? `${CLASSE_CAMPO_TRAVADO} appearance-none` : "campo"}
          disabled={travaAmbiente}
          value={ambiente}
          onChange={(e) => setAmbiente(e.target.value)}
        >
          <option value="">— não definido —</option>
          <option value="production">production (cobrança real)</option>
          <option value="sandbox">sandbox (pagamentos simulados)</option>
        </select>
        {travaAmbiente ? (
          <AvisoTravado secret={SECRET_DO_CAMPO.environment} />
        ) : (
          <p className="mt-1 text-xs text-stone-500">
            Origem atual: {ROTULO[estado.origem.environment]}. Definir aqui só vale se não houver secret{" "}
            <code className="rounded bg-stone-100 px-1">ASAAS_ENVIRONMENT</code>.
          </p>
        )}
      </div>

      {/* Token do webhook ------------------------------------------------------- */}
      <div>
        <div className="flex items-center justify-between gap-2">
          <label className="rotulo">Token do webhook</label>
          <EtiquetaOrigem origem={estado.origem.webhookToken} />
        </div>
        <input
          type="text"
          className={`${travaToken ? CLASSE_CAMPO_TRAVADO : "campo"} font-mono`}
          disabled={travaToken}
          autoComplete="off"
          spellCheck={false}
          placeholder={
            travaToken
              ? "definido pelo secret do Worker"
              : estado.temToken
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
        {travaToken ? (
          <AvisoTravado secret={SECRET_DO_CAMPO.webhookToken} />
        ) : (
          <>
            <div className="mt-1 flex items-center justify-between gap-2">
              <p className="text-xs text-stone-500">
                Comparado em tempo constante com <code className="rounded bg-stone-100 px-1">?token=</code> na URL do
                webhook.
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
          </>
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
          <span className={`text-xs font-semibold ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.texto}</span>
        )}
      </div>
    </div>
  );
}
