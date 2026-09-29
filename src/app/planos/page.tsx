import Link from "next/link";
import { listarPlanos } from "@/lib/billing";

export const dynamic = "force-dynamic";

function money(centavos: number) {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

const DESTAQUES: Record<string, string[]> = {
  essencial: ["Reservas e orçamentos", "Clientes e estoque", "Financeiro", "Até 3 usuários"],
  profissional: ["Tudo do Essencial", "Portal do cliente e chat", "Relatórios e fidelidade", "Até 10 usuários"],
  empresarial: ["Tudo do Profissional", "Fretes e contratos avançados", "Suporte prioritário", "Até 30 usuários"],
};

/**
 * Landing comercial — catálogo público de planos (Etapa 4 do SaaS).
 *
 * Fora do grupo (app): sem sessão, sem gate de assinatura. Os preços e os
 * dias de trial vêm do catálogo da plataforma (tabela plans), nunca
 * hardcoded na tela.
 */
export default async function PlanosPage() {
  const planos = await listarPlanos();

  return (
    <main className="mx-auto w-full max-w-5xl px-5 py-10">
      <header className="mb-10 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-marca-600 text-2xl font-black text-white shadow-lg">
          L
        </div>
        <h1 className="text-3xl font-black tracking-tight text-tinta-900 sm:text-4xl">
          Sistema de locações para quem não quer planilha
        </h1>
        <p className="mx-auto mt-3 max-w-xl text-stone-500">
          Reservas, clientes, estoque e financeiro em um só lugar. Teste grátis por{" "}
          {Math.max(...planos.map((p) => p.trial_days), 14)} dias — sem cartão de crédito.
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/assinar"
            className="rounded-xl bg-marca-600 px-5 py-3 text-sm font-semibold text-white shadow hover:bg-marca-500"
          >
            Começar agora
          </Link>
          <a
            href="/login"
            className="rounded-xl border border-nuvem-300 bg-white px-5 py-3 text-sm font-semibold text-tinta-900 hover:bg-nuvem-50"
          >
            Já sou cliente
          </a>
        </div>
      </header>

      <section className="grid gap-4 sm:grid-cols-3">
        {planos.map((p, i) => (
          <div
            key={p.slug}
            className={`cartao flex flex-col p-5 ${i === 1 ? "border-marca-400 shadow-md ring-1 ring-marca-200" : ""}`}
          >
            {i === 1 && (
              <span className="mb-2 self-start rounded-full bg-marca-600 px-2.5 py-0.5 text-[0.7rem] font-bold uppercase tracking-wide text-white">
                Mais popular
              </span>
            )}
            <h2 className="text-lg font-black text-tinta-900">{p.name}</h2>
            {p.description && <p className="mt-1 text-sm text-stone-500">{p.description}</p>}
            <p className="mt-4">
              <span className="text-3xl font-black text-tinta-900">{money(p.price_cents)}</span>
              <span className="text-sm text-stone-500">/mês</span>
            </p>
            <ul className="mt-4 space-y-2 text-sm text-stone-600">
              {(DESTAQUES[p.slug] ?? []).map((item) => (
                <li key={item} className="flex items-start gap-2">
                  <span className="mt-0.5 text-emerald-600">✓</span> {item}
                </li>
              ))}
              <li className="flex items-start gap-2">
                <span className="mt-0.5 text-emerald-600">✓</span> {p.trial_days} dias grátis
              </li>
            </ul>
            <Link
              href={`/assinar?plano=${p.slug}`}
              className={`mt-5 rounded-xl px-4 py-2.5 text-center text-sm font-semibold transition ${
                i === 1
                  ? "bg-marca-600 text-white hover:bg-marca-500"
                  : "border border-nuvem-300 bg-white text-tinta-900 hover:bg-nuvem-50"
              }`}
            >
              Assinar o {p.name}
            </Link>
          </div>
        ))}
      </section>

      <footer className="mt-10 text-center text-xs text-stone-400">
        Dúvidas? Entre em contato com a equipe Limas Sistemas.
      </footer>
    </main>
  );
}
