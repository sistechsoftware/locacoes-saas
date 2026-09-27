import Link from "next/link";
import type { ReactNode } from "react";
import { TONE_CLASS, TONE_DOT, statusDef, type StatusDef, type Tone } from "@/lib/domain";

/* -------------------------------- textos ------------------------------- */

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-bold text-tinta-900 sm:text-2xl">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-stone-500">{subtitle}</p>}
      </div>
      {action && <div className="flex flex-wrap gap-2">{action}</div>}
    </div>
  );
}

export function Card({
  children,
  className = "",
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return <div className={`cartao ${padded ? "p-4" : ""} ${className}`}>{children}</div>;
}

export function Section({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`cartao overflow-hidden ${className}`}>
      <header className="flex items-center justify-between gap-2 border-b border-nuvem-200 bg-nuvem-50 px-4 py-3">
        <h2 className="text-sm font-bold uppercase tracking-wide text-stone-600">{title}</h2>
        {action}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Empty({ children = "Nenhum registro encontrado." }: { children?: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-nuvem-300 bg-nuvem-50 px-4 py-8 text-center text-sm text-stone-500">
      {children}
    </p>
  );
}

/* -------------------------------- status ------------------------------- */

export function Badge({
  tone = "cinza",
  children,
  className = "",
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function StatusBadge({ defs, value }: { defs: StatusDef[]; value: string }) {
  const d = statusDef(defs, value);
  return (
    <Badge tone={d.tone}>
      <span className={`h-1.5 w-1.5 rounded-full ${TONE_DOT[d.tone]}`} />
      {d.label}
    </Badge>
  );
}

/* -------------------------------- botoes ------------------------------- */

const BTN_BASE =
  "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition active:scale-[0.98] disabled:opacity-50";

export const BTN: Record<string, string> = {
  primario: `${BTN_BASE} bg-marca-600 text-white hover:bg-marca-500`,
  secundario: `${BTN_BASE} border border-nuvem-300 bg-white text-tinta-900 hover:bg-nuvem-50`,
  escuro: `${BTN_BASE} bg-marca-600 text-white hover:bg-marca-500`,
  perigo: `${BTN_BASE} border border-red-300 bg-red-50 text-red-700 hover:bg-red-100`,
  sucesso: `${BTN_BASE} bg-emerald-600 text-white hover:bg-emerald-700`,
  fantasma: `${BTN_BASE} text-marca-600 hover:bg-marca-50`,
};

export function LinkButton({
  href,
  variant = "secundario",
  children,
  className = "",
  target,
}: {
  href: string;
  variant?: keyof typeof BTN;
  children: ReactNode;
  className?: string;
  target?: string;
}) {
  return (
    <Link href={href} target={target} className={`${BTN[variant]} ${className}`}>
      {children}
    </Link>
  );
}

/* -------------------------------- dados -------------------------------- */

export function Stat({
  label,
  value,
  hint,
  href,
  tone,
  icon,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
  tone?: Tone;
  icon?: ReactNode;
}) {
  const body = (
    <div className="cartao h-full p-3 transition hover:border-marca-300 sm:p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[0.7rem] font-semibold uppercase leading-tight tracking-wide text-stone-500">{label}</p>
        {icon && <span className="text-base leading-none">{icon}</span>}
      </div>
      <p
        className={`mt-1.5 text-xl font-bold leading-tight sm:text-2xl ${
          tone === "vermelho" ? "text-red-600" : tone === "verde" ? "text-emerald-600" : "text-tinta-900"
        }`}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-stone-500">{hint}</p>}
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-nuvem-200 py-2 last:border-0">
      <span className="text-sm text-stone-500">{label}</span>
      <span className="text-right text-sm font-medium text-tinta-900">{value}</span>
    </div>
  );
}

export function Alerta({
  tone = "ambar",
  title,
  children,
}: {
  tone?: "ambar" | "vermelho" | "verde" | "azul";
  title?: string;
  children: ReactNode;
}) {
  const map = {
    ambar: "border-amber-300 bg-amber-50 text-amber-900",
    vermelho: "border-red-300 bg-red-50 text-red-800",
    verde: "border-emerald-300 bg-emerald-50 text-emerald-800",
    azul: "border-sky-300 bg-sky-50 text-sky-800",
  };
  return (
    <div className={`rounded-xl border px-3 py-2.5 text-sm ${map[tone]}`}>
      {title && <p className="font-bold">{title}</p>}
      <div className={title ? "mt-0.5" : ""}>{children}</div>
    </div>
  );
}

/* ------------------------------ formularios ---------------------------- */

export function Field({
  label,
  children,
  hint,
  className = "",
}: {
  label: string;
  children: ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="rotulo">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-stone-500">{hint}</p>}
    </div>
  );
}

export function Grid({ children, cols = 2 }: { children: ReactNode; cols?: 1 | 2 | 3 | 4 }) {
  const map = {
    1: "grid-cols-1",
    2: "grid-cols-1 sm:grid-cols-2",
    3: "grid-cols-2 sm:grid-cols-3",
    4: "grid-cols-2 sm:grid-cols-4",
  };
  return <div className={`grid gap-3 ${map[cols]}`}>{children}</div>;
}
