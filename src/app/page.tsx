import Link from "next/link";
import type { Metadata } from "next";
import { listarPlanos } from "@/lib/billing";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Lima's Locações — Sistema de gestão para locadoras e eventos",
  description:
    "Reservas, orçamentos, contratos, estoque, financeiro e portal do cliente em um só sistema. Teste grátis por 14 dias, sem cartão de crédito.",
};

/**
 * Home institucional do SaaS (Etapa 4).
 *
 * Substitui o antigo redirect da raiz: quem chega pela URL da plataforma vê a
 * apresentação do produto, com atalhos para /planos e /assinar. Quem já tem
 * conta entra por /login (e a PWA instalada abre direto no /dashboard, então
 * nada aqui atrapalha a operação). O prazo de trial no badge vem do catálogo —
 * mesma fonte de verdade das telas comerciais.
 */

function trialDias(planos: { trial_days: number }[]): number {
  return Math.max(...planos.map((p) => p.trial_days), 14);
}

const RECURSOS = [
  {
    icone: "📅",
    titulo: "Reservas e agenda",
    texto: "Calendário unificado com conflito de disponibilidade automático, checklists de saída/volta e timeline por item.",
  },
  {
    icone: "🧾",
    titulo: "Orçamentos e contratos",
    texto: "Orçamentos que viram reserva em um clique e contratos com modelos editáveis e assinatura pelo portal.",
  },
  {
    icone: "📦",
    titulo: "Estoque e kits",
    texto: "Itens, kits, promoções e compra de itens de terceiros — com revisão otimista para nunca reservar o mesmo item duas vezes.",
  },
  {
    icone: "💰",
    titulo: "Financeiro",
    texto: "Contas a pagar e receber, parcelamento, fretes, recibos e relatório de faturamento por período.",
  },
  {
    icone: "🌐",
    titulo: "Portal do cliente",
    texto: "Seu cliente acompanha orçamentos, contratos e assina de onde estiver, com link seguro — sem precisar ligar para você.",
  },
  {
    icone: "📊",
    titulo: "Relatórios",
    texto: "Faturamento por item, disponibilidade futura e histórico de clientes para decidir onde investir.",
  },
];

const PASSOS = [
  { n: "1", titulo: "Crie sua conta", texto: "Dois minutos: nome da empresa e um usuário. Sem cartão de crédito." },
  { n: "2", titulo: "Cadastre seus itens", texto: "Itens, kits, promoções e clientes. Importe do jeito que já funciona hoje." },
  { n: "3", titulo: "Use de verdade", texto: "Teste tudo por 14 dias. Gostou? Contrate na hora, direto no sistema." },
];

const FAQ = [
  {
    q: "Preciso de cartão de crédito para testar?",
    a: "Não. A conta nasce com o período de teste completo e nenhum pagamento é solicitado. Você só contrata um plano se gostar.",
  },
  {
    q: "O que acontece quando o teste acaba?",
    a: "O acesso fica temporariamente bloqueado até a contratação de um plano — nada é cobrado automaticamente e seus dados continuam guardados. Assim que o plano for contratado, tudo volta como estava.",
  },
  {
    q: "Funciona no celular?",
    a: "Sim. O sistema é um aplicativo instalável (PWA): instala na tela inicial do celular, funciona na estrada e manda notificações de agenda e mensagens.",
  },
  {
    q: "Posso trocar de plano depois?",
    a: "Pode. A troca é feita dentro do sistema, na tela de Faturamento, e o limite de usuários acompanha o plano na hora.",
  },
  {
    q: "Meus dados ficam isolados de outras empresas?",
    a: "Sim. Cada empresa tem seus próprios clientes, reservas e documentos, isolados no nível de banco — nem um usuário de outra empresa enxerga nada seu.",
  },
];

export default async function Home() {
  const planos = await listarPlanos();
  const dias = trialDias(planos);

  return (
    <div className="min-h-screen bg-gradient-to-b from-nuvem-200 to-nuvem-100">
      {/* ------------------------------ topo ------------------------------ */}
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-4">
        <div className="flex items-center gap-2.5">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-marca-600 text-xl font-black text-white shadow">
            L
          </div>
          <span className="text-sm font-black tracking-tight text-tinta-900">Lima&apos;s Locações</span>
        </div>
        <nav className="flex items-center gap-1 sm:gap-2">
          <a href="#recursos" className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-stone-600 hover:bg-white/60 sm:block">
            Recursos
          </a>
          <a href="#faq" className="hidden rounded-lg px-3 py-2 text-sm font-semibold text-stone-600 hover:bg-white/60 sm:block">
            Dúvidas
          </a>
          <Link href="/planos" className="rounded-lg px-3 py-2 text-sm font-semibold text-stone-600 hover:bg-white/60">
            Planos
          </Link>
          <Link
            href="/login"
            className="rounded-xl border border-nuvem-300 bg-white px-4 py-2 text-sm font-semibold text-tinta-900 hover:bg-nuvem-50"
          >
            Entrar
          </Link>
        </nav>
      </header>

      {/* ------------------------------ hero ------------------------------ */}
      <section className="mx-auto grid w-full max-w-5xl items-center gap-10 px-5 pb-16 pt-10 lg:grid-cols-[1.1fr_0.9fr] lg:pt-16">
        <div>
          <span className="inline-flex items-center gap-2 rounded-full border border-marca-200 bg-white px-3 py-1 text-xs font-bold uppercase tracking-wide text-marca-600">
            🎉 {dias} dias grátis, sem cartão
          </span>
          <h1 className="mt-4 text-4xl font-black leading-tight tracking-tight text-tinta-900 sm:text-5xl">
            Sua locação inteira em um só sistema
          </h1>
          <p className="mt-4 max-w-xl text-lg text-stone-600">
            Reservas, orçamentos, contratos, estoque e financeiro — com portal para o seu cliente assinar de
            onde estiver. Feito para locadoras e eventos que já cansaram de planilha e caderno.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <Link
              href="/assinar"
              className="rounded-xl bg-marca-600 px-6 py-3.5 text-base font-bold text-white shadow-lg shadow-marca-600/20 hover:bg-marca-500"
            >
              Começar grátis agora
            </Link>
            <Link
              href="/planos"
              className="rounded-xl border border-nuvem-300 bg-white px-6 py-3.5 text-base font-semibold text-tinta-900 hover:bg-nuvem-50"
            >
              Ver planos e preços
            </Link>
          </div>
          <p className="mt-4 text-sm text-stone-500">
            Sem fidelidade · Cancele quando quiser · Funciona no celular
          </p>
        </div>

        {/* Prévia estática do produto (puro CSS, sem imagem) */}
        <div className="hidden lg:block">
          <div className="cartao overflow-hidden shadow-xl shadow-marca-900/10">
            <div className="flex items-center gap-1.5 border-b border-nuvem-200 bg-nuvem-50 px-4 py-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
              <span className="h-2.5 w-2.5 rounded-full bg-amber-300" />
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-300" />
              <span className="ml-3 text-xs font-semibold text-stone-400">dashboard · hoje</span>
            </div>
            <div className="grid grid-cols-3 gap-2 p-4">
              {[
                ["Reservas hoje", "7"],
                ["Orçamentos", "12"],
                ["A receber", "R$ 8.4k"],
              ].map(([r, v]) => (
                <div key={r} className="rounded-xl border border-nuvem-200 bg-nuvem-50 p-2.5">
                  <p className="text-[0.65rem] font-bold uppercase tracking-wide text-stone-400">{r}</p>
                  <p className="mt-0.5 text-lg font-black text-tinta-900">{v}</p>
                </div>
              ))}
            </div>
            <div className="space-y-2 px-4 pb-4">
              {[
                ["10:00", "Cadeiras venezianas (120)", "Retirada"],
                ["13:30", "Som + palco · Festa Junina", "Evento"],
                ["16:00", "Mesas de vidro (12)", "Devolução"],
              ].map(([h, t, tag]) => (
                <div key={h} className="flex items-center gap-3 rounded-xl border border-nuvem-200 bg-white px-3 py-2">
                  <span className="text-xs font-bold text-marca-600">{h}</span>
                  <span className="flex-1 truncate text-sm text-tinta-900">{t}</span>
                  <span className="rounded-full bg-nuvem-100 px-2 py-0.5 text-[0.65rem] font-bold text-stone-500">{tag}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* --------------------------- faixa de valores ---------------------- */}
      <section className="border-y border-nuvem-200 bg-white/70">
        <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-4 px-5 py-6 sm:grid-cols-3">
          {[
            ["📱", "Instalável no celular", "PWA com notificações: agenda, mensagens e alertas na mão."],
            ["🔒", "Dados isolados", "Cada empresa num compartimento próprio, com backup no Cloudflare."],
            ["💬", "Portal e chat do cliente", "Menos telefone: orçamento, contrato e assinatura por link."],
          ].map(([icone, t, x]) => (
            <div key={t} className="flex items-start gap-3">
              <span className="text-2xl">{icone}</span>
              <div>
                <p className="font-bold text-tinta-900">{t}</p>
                <p className="text-sm text-stone-500">{x}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ----------------------------- recursos ---------------------------- */}
      <section id="recursos" className="mx-auto w-full max-w-5xl px-5 py-16">
        <h2 className="text-center text-3xl font-black tracking-tight text-tinta-900">
          Tudo que a operação precisa, sem gambiarra
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-center text-stone-500">
          Cada módulo existe porque uma locadora de verdade precisou dele. Nada de recursos de enfeite.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {RECURSOS.map((r) => (
            <div key={r.titulo} className="cartao p-5">
              <span className="text-3xl">{r.icone}</span>
              <h3 className="mt-3 font-black text-tinta-900">{r.titulo}</h3>
              <p className="mt-1 text-sm leading-relaxed text-stone-600">{r.texto}</p>
            </div>
          ))}
        </div>
      </section>

      {/* --------------------------- como funciona ------------------------- */}
      <section className="border-y border-nuvem-200 bg-white/70">
        <div className="mx-auto w-full max-w-5xl px-5 py-14">
          <h2 className="text-center text-3xl font-black tracking-tight text-tinta-900">Começar é simples</h2>
          <div className="mt-8 grid gap-4 sm:grid-cols-3">
            {PASSOS.map((p) => (
              <div key={p.n} className="cartao p-5">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-marca-600 font-black text-white">
                  {p.n}
                </span>
                <h3 className="mt-3 font-black text-tinta-900">{p.titulo}</h3>
                <p className="mt-1 text-sm text-stone-600">{p.texto}</p>
              </div>
            ))}
          </div>
          <div className="mt-8 text-center">
            <Link
              href="/assinar"
              className="inline-block rounded-xl bg-marca-600 px-6 py-3.5 text-base font-bold text-white shadow-lg shadow-marca-600/20 hover:bg-marca-500"
            >
              Criar minha conta grátis
            </Link>
          </div>
        </div>
      </section>

      {/* ------------------------------- FAQ ------------------------------- */}
      <section id="faq" className="mx-auto w-full max-w-3xl px-5 py-16">
        <h2 className="text-center text-3xl font-black tracking-tight text-tinta-900">Perguntas frequentes</h2>
        <div className="mt-8 space-y-3">
          {FAQ.map((f) => (
            <details key={f.q} className="cartao group p-4">
              <summary className="cursor-pointer list-none font-bold text-tinta-900 marker:hidden">
                <span className="mr-2 text-marca-600 transition group-open:rotate-90 inline-block">▸</span>
                {f.q}
              </summary>
              <p className="mt-2 pl-6 text-sm leading-relaxed text-stone-600">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ------------------------------ rodapé ----------------------------- */}
      <footer className="border-t border-nuvem-200 bg-white/70">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center gap-3 px-5 py-8 text-center sm:flex-row sm:justify-between sm:text-left">
          <div>
            <p className="font-black text-tinta-900">Lima&apos;s Locações</p>
            <p className="text-xs text-stone-500">Sistema de gestão para locadoras e eventos · Limas Sistemas</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-4 text-sm font-semibold text-marca-600">
            <Link href="/planos" className="hover:underline">Planos</Link>
            <Link href="/assinar" className="hover:underline">Criar conta</Link>
            <Link href="/login" className="hover:underline">Entrar</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
