import Link from "next/link";
import { requireCliente } from "@/lib/portal-auth";
import {
  configuracaoPortal,
  financeiroDoCliente,
  perfilDoCliente,
  proximaReserva,
  ultimaLocacao,
} from "@/lib/portal";
import { painelDoCliente } from "@/lib/fidelidade-db";
import { dateBR, money, onlyDigits, phoneBR, waLink } from "@/lib/format";
import FidelidadeHero from "../FidelidadeHero";

export const dynamic = "force-dynamic";

/**
 * Pagina inicial do Portal do Cliente.
 *
 * A pergunta que a tela responde em cinco segundos: "quanto ja avancei no
 * programa de fidelidade e quanto falta para a minha proxima locacao gratis?".
 */
export default async function PortalHome() {
  const cliente = await requireCliente();
  const [cfg, perfil, fidelidade, financeiro, proxima, ultima] = await Promise.all([
    configuracaoPortal(),
    perfilDoCliente(cliente.id),
    painelDoCliente(cliente.id),
    financeiroDoCliente(cliente.id),
    proximaReserva(cliente.id),
    ultimaLocacao(cliente.id),
  ]);

  const waMsg = `Olá! Sou ${cliente.name} e gostaria de fazer uma nova locação.`;
  const wa = waLink(cfg.whatsapp || perfil?.whatsapp || perfil?.phone || "", waMsg);
  const recorrente = (perfil?.locacoes ?? 0) > 1;

  return (
    <div className="space-y-4">
      <FidelidadeHero
        regra={fidelidade.regra}
        progresso={fidelidade.progresso}
        recompensas={fidelidade.recompensas}
        hoje={new Date().toISOString().slice(0, 10)}
      />

      {cfg.aviso && (
        <div className="rounded-2xl border border-destaque-300 bg-destaque-100 px-4 py-3 text-sm text-destaque-700">
          <span className="mr-1">📣</span>
          {cfg.aviso}
        </div>
      )}

      {/* proxima reserva */}
      {proxima ? (
        <Link href={`/portal/historico/${proxima.id}`} className="block cartao p-4 transition hover:border-marca-300">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-bold uppercase tracking-wide text-marca-600">Sua próxima locação</p>
              <p className="mt-1 text-lg font-bold text-tinta-900">
                📅 {dateBR(proxima.event_date)}
                {proxima.event_time ? ` · ${proxima.event_time.slice(0, 5)}` : ""}
              </p>
              <p className="mt-0.5 text-sm text-stone-600">
                📦 {Number(proxima.itens_qty ?? 0)} item(ns)
                {proxima.itens ? ` · ${proxima.itens}` : ""}
              </p>
              {(proxima.address || proxima.district || proxima.city) && (
                <p className="mt-0.5 truncate text-sm text-stone-600">
                  📍 {[proxima.address, proxima.district, proxima.city].filter(Boolean).join(", ")}
                </p>
              )}
            </div>
            <span className="shrink-0 rounded-full border border-emerald-300 bg-emerald-50 px-2.5 py-1 text-xs font-bold text-emerald-700">
              {proxima.status === "confirmada" ? "Confirmada" : "Reservado"}
            </span>
          </div>
        </Link>
      ) : (
        <div className="cartao flex flex-wrap items-center justify-between gap-3 p-4">
          <div>
            <p className="text-sm font-bold text-tinta-900">Você não possui nenhuma reserva futura</p>
            <p className="text-xs text-stone-500">Que tal planejar a próxima comemoração?</p>
          </div>
          {wa && (
            <a
              href={wa}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-700"
            >
              💬 Pedir orçamento no WhatsApp
            </a>
          )}
        </div>
      )}

      {/* resumo */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div className="cartao p-3">
          <p className="text-[0.7rem] font-semibold uppercase leading-tight text-stone-500">Locações concluídas</p>
          <p className="mt-1 text-xl font-bold text-tinta-900">{financeiro.locacoes_concluidas}</p>
          <p className="text-xs text-stone-500">
            {financeiro.locacoes_concluidas}/{fidelidade.progresso.meta} no ciclo atual
          </p>
        </div>
        <div className="cartao p-3">
          <p className="text-[0.7rem] font-semibold uppercase leading-tight text-stone-500">Total em locações</p>
          <p className="mt-1 text-xl font-bold text-tinta-900">{money(financeiro.total_cents)}</p>
          <p className="text-xs text-stone-500">soma dos valores contratados</p>
        </div>
        <div className="cartao p-3">
          <p className="text-[0.7rem] font-semibold uppercase leading-tight text-stone-500">Última locação</p>
          <p className="mt-1 text-xl font-bold text-tinta-900">{ultima ? dateBR(ultima.event_date) : "—"}</p>
          <p className="text-xs text-stone-500">{ultima ? ultima.number : "nenhuma ainda"}</p>
        </div>
        <div className="cartao p-3">
          <p className="text-[0.7rem] font-semibold uppercase leading-tight text-stone-500">Próxima reserva</p>
          <p className="mt-1 text-xl font-bold text-tinta-900">{proxima ? dateBR(proxima.event_date) : "—"}</p>
          <p className="text-xs text-stone-500">{proxima ? "na sua agenda 🎉" : "sem reserva futura"}</p>
        </div>
      </div>

      {/* financeiro simples, no vocabulario do cliente */}
      <div className="cartao p-4">
        <p className="text-sm font-bold text-tinta-900">Seus números com a {cfg.empresa}</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-2xl font-black text-marca-700">{money(financeiro.total_cents)}</p>
            <p className="text-xs text-stone-500">Total em locações</p>
          </div>
          <div>
            <p className="text-2xl font-black text-emerald-600">{money(financeiro.pago_cents)}</p>
            <p className="text-xs text-stone-500">
              Já pago ({financeiro.qtd_pagamentos} pagamento{financeiro.qtd_pagamentos === 1 ? "" : "s"})
            </p>
          </div>
          <div>
            <p className={`text-2xl font-black ${financeiro.saldo_cents > 0 ? "text-red-600" : "text-tinta-900"}`}>
              {money(financeiro.saldo_cents)}
            </p>
            <p className="text-xs text-stone-500">Saldo em aberto</p>
          </div>
        </div>
      </div>

      {recorrente && (
        <p className="text-center text-xs font-semibold text-destaque-700">
          ⭐ Cliente recorrente — obrigado pela confiança!
        </p>
      )}

      {/* contato */}
      <div className="cartao p-4">
        <p className="text-sm font-bold text-tinta-900">Fale com a {cfg.empresa}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {wa && (
            <a
              href={wa}
              target="_blank"
              rel="noreferrer"
              className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm font-semibold text-white"
            >
              💬 WhatsApp
            </a>
          )}
          {(cfg.telefone || perfil?.phone) && (
            <a
              href={`tel:${(cfg.telefone || perfil?.phone)!.replace(/[^\d+]/g, "")}`}
              className="rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold text-tinta-900"
            >
              📞 {phoneBR(cfg.telefone || perfil?.phone)}
            </a>
          )}
          {cfg.email && (
            <a
              href={`mailto:${cfg.email}`}
              className="rounded-xl border border-nuvem-300 bg-white px-4 py-2.5 text-sm font-semibold text-tinta-900"
            >
              ✉️ {cfg.email}
            </a>
          )}
        </div>
        <p className="mt-2 text-xs text-stone-500">
          Cliente desde {dateBR(perfil?.created_at)} · CPF {perfil?.doc ? onlyDigits(perfil.doc).replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : "—"}
        </p>
      </div>
    </div>
  );
}
