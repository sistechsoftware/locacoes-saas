"use client";
import { useMemo, useState, useTransition } from "react";
import { LISTA_RECURSOS, RECURSOS, type OrigemPermissao, type Recurso } from "@/lib/planos";
import { salvarLimiteUsuariosAction, salvarRecursosEmpresaAction } from "../../actions";

/**
 * Editor em LOTE das permissões da empresa (só apresentação — o guard é na
 * action, no servidor). Cada funcionalidade tem três estados:
 *  * auto     — regra do plano contratado (sem linha de ajuste);
 *  * liberar  — liberação excepcional permanente (sem troca de plano/cobrança);
 *  * bloquear — bloqueio excepcional (prevalece sobre plano e cortesia).
 * As mudanças são revisadas antes de salvar (resumo do que será alterado) e
 * aplicadas numa única operação no servidor, com motivo obrigatório.
 */
export default function RecursosEmpresa({
  companyId,
  recursos,
  limiteAtual,
  limiteAjustado,
}: {
  companyId: number;
  recursos: { recurso: Recurso; origem: OrigemPermissao; liberado: boolean }[];
  limiteAtual: number;
  limiteAjustado: number | null;
}) {
  // Estado inicial: o efeito gravado (allow/block), não o resultado efetivo.
  const inicial = useMemo(() => {
    const m: Record<string, "auto" | "liberar" | "bloquear"> = {};
    for (const r of recursos) {
      m[r.recurso] = r.origem === "liberacao_admin" ? "liberar" : r.origem === "bloqueio_admin" ? "bloquear" : "auto";
    }
    return m;
  }, [recursos]);

  const [efeitos, setEfeitos] = useState<Record<string, "auto" | "liberar" | "bloquear">>(inicial);
  const [motivo, setMotivo] = useState("");
  const [limite, setLimite] = useState<string>(String(limiteAjustado ?? ""));
  const [msg, setMsg] = useState<string | null>(null);
  const [erro, setErro] = useState(false);
  const [pending, start] = useTransition();

  const alteracoes = useMemo(
    () => LISTA_RECURSOS.filter((r) => efeitos[r] !== inicial[r]).map((r) => ({ recurso: r, efeito: efeitos[r] })),
    [efeitos, inicial],
  );
  const limiteMudou = (limiteAjustado ?? "") !== limite.trim() && !(limite.trim() === "" && limiteAjustado === null);

  function salvar() {
    if (alteracoes.length === 0 && !limiteMudou) return;
    if (motivo.trim().length < 3) {
      setErro(true);
      setMsg("Informe o motivo da alteração (mínimo 3 caracteres).");
      return;
    }
    setErro(false);
    setMsg(null);
    start(async () => {
      if (alteracoes.length > 0) {
        const r = await salvarRecursosEmpresaAction(companyId, alteracoes, motivo.trim());
        if (!r.ok) {
          setErro(true);
          setMsg(r.mensagem);
          return;
        }
      }
      if (limiteMudou) {
        const valor = limite.trim() === "" ? null : Number(limite);
        if (valor !== null && (!Number.isInteger(valor) || valor < 1 || valor > 500)) {
          setErro(true);
          setMsg("Limite de usuários deve ser um número inteiro entre 1 e 500 (ou vazio para voltar ao do plano).");
          return;
        }
        const rl = await salvarLimiteUsuariosAction(companyId, valor, motivo.trim());
        if (!rl.ok) {
          setErro(true);
          setMsg(rl.mensagem);
          return;
        }
      }
      setMsg("Alterações salvas. O plano contratado e o preço permanecem inalterados.");
    });
  }

  const resumo = alteracoes
    .map((a) => {
      const nome = RECURSOS[a.recurso].nome;
      return a.efeito === "liberar" ? `liberar ${nome}` : a.efeito === "bloquear" ? `bloquear ${nome}` : `restaurar padrão de ${nome}`;
    })
    .join(", ");

  return (
    <div className="rounded-xl border border-nuvem-200 bg-nuvem-50 p-3">
      <p className="text-xs font-bold uppercase tracking-wide text-stone-500">Personalizar permissões desta empresa</p>
      <p className="mt-0.5 text-xs text-stone-500">
        Liberações e bloqueios são exceções administrativas: não alteram o plano contratado, o preço ou a cobrança, e
        valem até serem removidos aqui.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {LISTA_RECURSOS.map((r) => {
          const def = RECURSOS[r];
          return (
            <label key={r} className="flex items-center justify-between gap-2 rounded-lg border border-nuvem-200 bg-white px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-tinta-900">{def.nome}</span>
                <span className="block text-[0.68rem] text-stone-500">
                  {def.fundamental ? "base — todo plano" : `a partir do ${def.minimo}`}
                </span>
              </span>
              <select
                value={efeitos[r]}
                onChange={(e) => setEfeitos((v) => ({ ...v, [r]: e.target.value as any }))}
                disabled={pending}
                className="shrink-0 rounded-lg border border-stone-300 px-2 py-1 text-xs"
              >
                <option value="auto">Padrão do plano</option>
                <option value="liberar">Liberar</option>
                <option value="bloquear">Bloquear</option>
              </select>
            </label>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs font-semibold text-stone-600">
          Limite de usuários
          <input
            type="number"
            min={1}
            max={500}
            value={limite}
            onChange={(e) => setLimite(e.target.value)}
            disabled={pending}
            placeholder={`padrão do plano (${limiteAtual})`}
            className="ml-2 w-24 rounded-lg border border-stone-300 px-2 py-1 text-sm font-normal"
          />
        </label>
        <label className="min-w-52 flex-1 text-xs font-semibold text-stone-600">
          Motivo (obrigatório)
          <input
            type="text"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
            disabled={pending}
            maxLength={300}
            placeholder="Ex.: acordo comercial de onboarding"
            className="mt-1 w-full rounded-lg border border-stone-300 px-2 py-1.5 text-sm font-normal"
          />
        </label>
      </div>

      {alteracoes.length > 0 && (
        <p className="mt-2 rounded-lg bg-marca-50 px-3 py-2 text-xs font-medium text-marca-800">
          Será aplicado: {resumo}.
        </p>
      )}

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={salvar}
          disabled={pending || (alteracoes.length === 0 && !limiteMudou)}
          className="rounded-xl bg-marca-600 px-4 py-2 text-sm font-semibold text-white hover:bg-marca-700 disabled:opacity-50"
        >
          {pending ? "Salvando…" : "Salvar alterações"}
        </button>
        {msg && <span className={`text-xs ${erro ? "text-red-600" : "text-stone-500"}`}>{msg}</span>}
      </div>
    </div>
  );
}
