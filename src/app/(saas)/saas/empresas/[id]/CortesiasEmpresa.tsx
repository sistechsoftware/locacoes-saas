"use client";
import { useState, useTransition } from "react";
import { NOME_DO_PLANO, ORDEM_PLANOS } from "@/lib/planos";
import { criarCortesiaAction, cancelarCortesiaAction } from "../../actions";

type EstadoCortesia = "programada" | "ativa" | "expirada" | "cancelada";

type CortesiaView = {
  id: number;
  plan_slug: string;
  starts_at: string;
  ends_at: string;
  reason: string;
  estado: EstadoCortesia;
  created_by_name: string | null;
  canceled_at: string | null;
};

const TONE: Record<EstadoCortesia, string> = {
  ativa: "bg-verde-50 text-verde-700 border-verde-200",
  programada: "bg-azul-50 text-azul-700 border-azul-200",
  expirada: "bg-stone-100 text-stone-500 border-stone-200",
  cancelada: "bg-red-50 text-red-600 border-red-200",
};

const ROTULO: Record<EstadoCortesia, string> = {
  ativa: "Ativa",
  programada: "Programada",
  expirada: "Expirada",
  cancelada: "Cancelada",
};

const PREDEFINIDOS = [7, 14, 30, 90] as const;

/** 'YYYY-MM-DDTHH:MM' no fuso do negócio, para o input datetime-local. */
function localISO(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  // America/Sao_Paulo (UTC-3, sem DST desde 1999) — mesmo fuso do nowLocal().
  const sp = new Date(d.getTime() - 3 * 3600000);
  return `${sp.getUTCFullYear()}-${p(sp.getUTCMonth() + 1)}-${p(sp.getUTCDate())}T${p(sp.getUTCHours())}:${p(sp.getUTCMinutes())}`;
}

function somaDias(iso: string, dias: number): string {
  const base = Date.parse(iso.length === 16 ? iso + ":00Z" : iso);
  if (!Number.isFinite(base)) return iso;
  return localISO(new Date(base + dias * 86400000));
}

/**
 * Concessão e cancelamento de cortesias (só apresentação — o guard é na action).
 * A cortesia é independente da assinatura comercial: não gera cobrança, não
 * altera preço e não substitui o plano contratado; é o plano-referência dos
 * benefícios TEMPORÁRIOS cedidos por uma janela de tempo definida aqui.
 */
export default function CortesiasEmpresa({ companyId, cortesias }: { companyId: number; cortesias: CortesiaView[] }) {
  const [aberto, setAberto] = useState(false);
  const [plano, setPlano] = useState<string>("");
  const [inicio, setInicio] = useState<string>(localISO());
  const [fim, setFim] = useState<string>(somaDias(localISO(), 30));
  const [motivo, setMotivo] = useState("");
  const [obs, setObs] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [erro, setErro] = useState(false);
  const [pending, start] = useTransition();

  function aplicarDias(dias: number) {
    setInicio((i) => {
      setFim(somaDias(i, dias));
      return i;
    });
  }

  function criar() {
    setErro(false);
    setMsg(null);
    start(async () => {
      const r = await criarCortesiaAction(companyId, {
        planSlug: plano,
        startsAt: inicio,
        endsAt: fim,
        motivo,
        observacoes: obs,
      });
      setErro(!r.ok);
      setMsg(r.mensagem);
      if (r.ok) {
        setAberto(false);
        setMotivo("");
        setObs("");
      }
    });
  }

  function cancelar(id: number) {
    if (!confirm("Cancelar esta cortesia? Só os benefícios dela encerram — a assinatura comercial não muda.")) return;
    setErro(false);
    setMsg(null);
    start(async () => {
      const r = await cancelarCortesiaAction(id);
      setErro(!r.ok);
      setMsg(r.mensagem);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-stone-500">
          Cortesia é um benefício TEMPORÁRIO com vigência definida: libera os recursos do plano-referência pelo período
          escolhido, sem cobrança e sem alterar a assinatura contratada. Ao expirar (ou ser cancelada), a empresa volta
          às condições comerciais vigentes, mantendo as exceções administrativas permanentes.
        </p>
        <button
          type="button"
          onClick={() => setAberto((v) => !v)}
          disabled={pending}
          className="shrink-0 rounded-xl bg-marca-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-marca-700 disabled:opacity-60"
        >
          {aberto ? "Fechar" : "Conceder cortesia"}
        </button>
      </div>

      {aberto && (
        <div className="rounded-xl border border-nuvem-200 bg-nuvem-50 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-stone-600">
              Plano-referência dos benefícios
              <select
                value={plano}
                onChange={(e) => setPlano(e.target.value)}
                disabled={pending}
                className="mt-1 w-full rounded-lg border border-stone-300 px-2 py-1.5 text-sm font-normal"
              >
                <option value="">Escolher plano…</option>
                {ORDEM_PLANOS.map((s) => (
                  <option key={s} value={s}>
                    {NOME_DO_PLANO[s]}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex flex-wrap items-end gap-1.5">
              <span className="w-full text-xs font-semibold text-stone-600">Período rápido</span>
              {PREDEFINIDOS.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => aplicarDias(d)}
                  disabled={pending}
                  className="rounded-lg border border-stone-300 bg-white px-2.5 py-1 text-xs font-semibold text-stone-700 hover:bg-stone-50 disabled:opacity-60"
                >
                  {d} dias
                </button>
              ))}
            </div>
            <label className="text-xs font-semibold text-stone-600">
              Início (data e hora — Brasília)
              <input
                type="datetime-local"
                value={inicio}
                onChange={(e) => setInicio(e.target.value)}
                disabled={pending}
                className="mt-1 w-full rounded-lg border border-stone-300 px-2 py-1.5 text-sm font-normal"
              />
            </label>
            <label className="text-xs font-semibold text-stone-600">
              Término (data e hora — Brasília)
              <input
                type="datetime-local"
                value={fim}
                onChange={(e) => setFim(e.target.value)}
                disabled={pending}
                className="mt-1 w-full rounded-lg border border-stone-300 px-2 py-1.5 text-sm font-normal"
              />
            </label>
            <label className="text-xs font-semibold text-stone-600 sm:col-span-2">
              Motivo (obrigatório)
              <input
                type="text"
                value={motivo}
                onChange={(e) => setMotivo(e.target.value)}
                disabled={pending}
                maxLength={300}
                placeholder="Ex.: compensação por indisponibilidade na semana passada"
                className="mt-1 w-full rounded-lg border border-stone-300 px-2 py-1.5 text-sm font-normal"
              />
            </label>
            <label className="text-xs font-semibold text-stone-600 sm:col-span-2">
              Observações (opcional)
              <input
                type="text"
                value={obs}
                onChange={(e) => setObs(e.target.value)}
                disabled={pending}
                maxLength={500}
                className="mt-1 w-full rounded-lg border border-stone-300 px-2 py-1.5 text-sm font-normal"
              />
            </label>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              onClick={criar}
              disabled={pending || !plano || motivo.trim().length < 3}
              className="rounded-xl bg-marca-600 px-4 py-2 text-sm font-semibold text-white hover:bg-marca-700 disabled:opacity-50"
            >
              {pending ? "Concedendo…" : "Conceder cortesia"}
            </button>
            <span className="text-xs text-stone-500">
              Sem cobrança: a cortesia não gera fatura nem altera o preço contratado.
            </span>
          </div>
        </div>
      )}

      {msg && <p className={`text-xs ${erro ? "text-red-600" : "text-stone-600"}`}>{msg}</p>}

      {cortesias.length === 0 ? (
        <p className="text-sm text-stone-500">Nenhuma cortesia registrada para esta empresa.</p>
      ) : (
        <div className="divide-y divide-nuvem-100 rounded-xl border border-nuvem-200">
          {cortesias.map((c) => (
            <div key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-tinta-900">
                  {NOME_DO_PLANO[c.plan_slug as keyof typeof NOME_DO_PLANO] ?? c.plan_slug}{" "}
                  <span className="ml-1.5 text-xs font-normal text-stone-500">
                    #{c.id} · {c.starts_at.replace("T", " ")} → {c.ends_at.replace("T", " ")}
                  </span>
                </p>
                <p className="text-xs text-stone-500">
                  {c.reason}
                  {c.created_by_name ? ` · concedida por ${c.created_by_name}` : ""}
                  {c.canceled_at ? ` · cancelada em ${c.canceled_at.replace("T", " ")}` : ""}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${TONE[c.estado]}`}>
                  {ROTULO[c.estado]}
                </span>
                {(c.estado === "ativa" || c.estado === "programada") && (
                  <button
                    type="button"
                    onClick={() => cancelar(c.id)}
                    disabled={pending}
                    className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:opacity-60"
                  >
                    Cancelar
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
