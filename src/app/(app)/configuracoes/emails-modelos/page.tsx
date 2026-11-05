import Link from "next/link";
import { all } from "@/lib/db";
import { requireModule } from "@/lib/auth";
import { ehAdmin } from "@/lib/roles";
import { getSettings } from "@/lib/settings";
import { lerModelos } from "@/lib/email-modelos";
import { PageHeader, Alerta } from "@/components/ui";
import ModelosEmail from "../ModelosEmail";

export const dynamic = "force-dynamic";

/**
 * Editor de modelos de e-mail (Configurações > Notificações > E-mails).
 *
 * Escopo: company_id da SESSÃO (requireModule + getSettings + setSettings nas
 * actions). Os modelos lidos são os DESTA empresa; a reserva usada na prévia é
 * lida por `dadosDaReserva`, que confere o tenant antes de devolver qualquer
 * dado — reserva de outra empresa simplesmente cai na amostra.
 */
export default async function ModelosEmailPage() {
  const ctx = await requireModule("configuracoes");
  const admin = ehAdmin(ctx.user.role);
  const s = await getSettings();
  const modelos = lerModelos(s);

  const reservas = await all<{ id: number; number: string; customer_name: string | null }>(
    `SELECT r.id, r.number, c.name AS customer_name
       FROM reservations r
       LEFT JOIN customers c ON c.id = r.customer_id
      WHERE r.company_id = ?
      ORDER BY r.id DESC
      LIMIT 20`,
    [ctx.companyId],
  );

  return (
    <div className="space-y-4">
      <PageHeader
        title="Modelos de e-mail"
        subtitle="Assunto e textos dos avisos enviados aos clientes desta empresa"
        action={
          <Link href="/configuracoes?aba=notificacoes" className="text-sm font-semibold text-marca-600">
            Voltar às notificações
          </Link>
        }
      />

      {!admin && (
        <Alerta tone="ambar">
          Você pode consultar os modelos, mas apenas o administrador da empresa pode salvar alterações.
        </Alerta>
      )}

      <ModelosEmail
        modelos={modelos}
        admin={admin}
        reservas={reservas.map((r) => ({
          id: r.id,
          rotulo: `${r.number} — ${r.customer_name ?? "cliente"}`,
        }))}
      />
    </div>
  );
}
