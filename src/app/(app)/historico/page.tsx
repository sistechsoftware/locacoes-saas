import { all, scalar } from "@/lib/db";
import { requireUser } from "@/lib/auth";
import { Empty, PageHeader } from "@/components/ui";
import { Pagination, SearchForm } from "@/components/List";
import { utcParaLocal } from "@/lib/format";

export const dynamic = "force-dynamic";
const PER_PAGE = 50;

const LINK: Record<string, (id: number) => string> = {
  reserva: (id) => `/reservas/${id}`,
  cliente: (id) => `/clientes/${id}`,
  produto: (id) => `/estoque/${id}`,
  orcamento: (id) => `/orcamentos/${id}`,
  frete: (id) => `/fretes/${id}`,
  contrato: (id) => `/contratos/${id}`,
  operacao: (id) => `/operacao/${id}`,
};

export default async function HistoricoPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; entidade?: string }>;
}) {
  await requireUser();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const page = Math.max(1, Number(sp.page ?? 1));

  const where: string[] = [];
  const params: any[] = [];
  if (q) {
    where.push("(summary LIKE ? OR user_name LIKE ? OR entity LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await scalar<number>(`SELECT COUNT(*) FROM audit_logs ${clause}`, params);
  const rows = await all<any>(`SELECT * FROM audit_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, [
    ...params,
    PER_PAGE,
    (page - 1) * PER_PAGE,
  ]);

  return (
    <div className="space-y-4">
      <PageHeader title="Histórico de Operações" subtitle={`${total} registro(s) de auditoria`} />
      <SearchForm action="/historico" placeholder="Usuário, ação, reserva…" defaultValue={q} />

      {rows.length === 0 ? (
        <Empty>Nenhum registro encontrado.</Empty>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((h) => {
            const href = h.entity_id && LINK[h.entity] ? LINK[h.entity](h.entity_id) : null;
            const conteudo = (
              <>
                <span className="block text-sm text-tinta-900">{h.summary}</span>
                <span className="block text-xs text-stone-400">
                  {utcParaLocal(h.created_at)} · {h.user_name} · {h.action} em {h.entity}
                </span>
              </>
            );
            return (
              <li key={h.id} className="cartao p-3">
                {href ? (
                  <a href={href} className="block hover:opacity-80">
                    {conteudo}
                  </a>
                ) : (
                  conteudo
                )}
              </li>
            );
          })}
        </ul>
      )}

      <Pagination
        page={page}
        total={total}
        perPage={PER_PAGE}
        build={(p) => `/historico?page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`}
      />
      <p className="text-center text-xs text-stone-400">
        Os registros de auditoria não podem ser apagados pelo sistema.
      </p>
    </div>
  );
}
