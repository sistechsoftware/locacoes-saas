import Link from "next/link";
import { Icon } from "./Icons";

/** Campo de busca simples baseado em GET, sem JavaScript no cliente. */
export function SearchForm({
  action,
  placeholder = "Buscar...",
  defaultValue = "",
  hidden = {},
  children,
}: {
  action: string;
  placeholder?: string;
  defaultValue?: string;
  hidden?: Record<string, string | undefined>;
  children?: React.ReactNode;
}) {
  return (
    <form action={action} className="pilha-filtros">
      {Object.entries(hidden).map(([k, v]) =>
        v ? <input key={k} type="hidden" name={k} value={v} /> : null,
      )}
      {/* min-w-0: dentro de um flex, deixa o campo encolher ate caber na tela
          de 320px em vez de estourar a largura com o icone por cima do texto */}
      <div className="relative min-w-0 flex-1 basis-48">
        <Icon name="busca" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
        <input name="q" defaultValue={defaultValue} placeholder={placeholder} className="campo pl-9" />
      </div>
      {children}
      <button className="w-full rounded-xl bg-marca-600 px-4 py-2.5 text-sm font-semibold text-white sm:w-auto">
        Buscar
      </button>
    </form>
  );
}

/** Abas de filtro renderizadas como links (mantem o estado na URL). */
export function Tabs({
  items,
  current,
  base,
  param = "aba",
}: {
  items: { value: string; label: string; count?: number }[];
  current: string;
  base: string;
  param?: string;
}) {
  return (
    <div className="scroll-x -mx-3 abas-barra px-3 sm:mx-0 sm:px-0">
      {items.map((t) => {
        const active = t.value === current;
        const sep = base.includes("?") ? "&" : "?";
        return (
          <Link
            key={t.value}
            href={`${base}${sep}${param}=${t.value}`}
            className={`shrink-0 whitespace-nowrap rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
              active
                ? "border-marca-600 bg-marca-600 text-white"
                : "border-nuvem-300 bg-white text-tinta-700 hover:bg-nuvem-50"
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={`ml-1.5 text-xs ${active ? "opacity-80" : "text-stone-400"}`}>{t.count}</span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

export function Pagination({
  page,
  total,
  perPage,
  build,
}: {
  page: number;
  total: number;
  perPage: number;
  build: (page: number) => string;
}) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  return (
    <nav className="flex items-center justify-between gap-2 pt-1">
      {page > 1 ? (
        <Link
          href={build(page - 1)}
          className="min-h-11 rounded-xl border border-nuvem-300 bg-white px-4 py-2 text-sm font-semibold"
        >
          Anterior
        </Link>
      ) : (
        <span />
      )}
      <span className="text-center text-xs text-stone-500">
        Página {page} de {pages} · {total} registro(s)
      </span>
      {page < pages ? (
        <Link
          href={build(page + 1)}
          className="min-h-11 rounded-xl border border-nuvem-300 bg-white px-4 py-2 text-sm font-semibold"
        >
          Próxima
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
}

/** Linha de lista clicavel, no formato de cartao (funciona bem no celular). */
export function ListRow({
  href,
  title,
  subtitle,
  meta,
  right,
  badges,
  body,
}: {
  href: string;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  meta?: React.ReactNode;
  right?: React.ReactNode;
  badges?: React.ReactNode;
  /** Bloco livre abaixo da linha. Fica fora do link para aceitar clique proprio. */
  body?: React.ReactNode;
}) {
  const linha = (
    <Link
      href={href}
      className={`flex items-center gap-3 p-3 transition ${body ? "" : "cartao hover:border-marca-300"}`}
    >
      <div className="min-w-0 flex-1">
        {badges && <div className="mb-1 flex flex-wrap gap-1.5">{badges}</div>}
        <p className="truncate text-sm font-bold text-tinta-900">{title}</p>
        {subtitle && <p className="truncate text-xs text-stone-600">{subtitle}</p>}
        {meta && <p className="truncate text-xs text-stone-400">{meta}</p>}
      </div>
      {right && <div className="shrink-0 text-right">{right}</div>}
      <Icon name="seta" className="h-4 w-4 shrink-0 text-stone-300" />
    </Link>
  );
  if (!body) return linha;
  return (
    <div className="cartao overflow-hidden transition hover:border-marca-300">
      {linha}
      <div className="border-t border-nuvem-200 px-3 py-2">{body}</div>
    </div>
  );
}
