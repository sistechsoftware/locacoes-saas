import Link from "next/link";
import { requireModule } from "@/lib/auth";
import { CATEGORIAS } from "@/lib/suporte";
import { Alerta, Field, LinkButton, PageHeader } from "@/components/ui";
import { abrirChamadoAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * Abrir chamado — pré-preenchível pelo Diário de erros
 * (/suporte/novo?assunto=...&descricao=...) para transformar um erro
 * registrado em um chamado sem redigitar o contexto.
 */
export default async function NovoChamadoPage({
  searchParams,
}: {
  searchParams: Promise<{ assunto?: string; descricao?: string; erro?: string }>;
}) {
  const { user } = await requireModule("suporte");
  const sp = await searchParams;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Novo chamado"
        subtitle="Descreva o que aconteceu — quanto mais contexto, mais rápida a resposta."
        action={
          <LinkButton href="/suporte" variant="secundario">
            Voltar
          </LinkButton>
        }
      />

      {sp.erro && <Alerta tone="vermelho">{sp.erro}</Alerta>}

      <form action={abrirChamadoAction} className="cartao space-y-4 p-4">
        <Field label="Categoria">
          <select name="categoria" className="campo" defaultValue="erro">
            {CATEGORIAS.map((c) => (
              <option key={c.valor} value={c.valor}>
                {c.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Assunto" hint={'Ex.: "Erro ao gerar o contrato da reserva 123".'}>
          <input
            name="assunto"
            className="campo"
            required
            minLength={4}
            maxLength={140}
            defaultValue={sp.assunto ?? ""}
            placeholder="Resumo do que aconteceu"
          />
        </Field>

        <Field
          label="Descrição"
          hint="O que você fez, o que esperava e o que aconteceu. Anexe um print se ajudar."
        >
          <textarea
            name="descricao"
            className="campo min-h-36"
            required
            minLength={10}
            maxLength={4000}
            defaultValue={sp.descricao ?? ""}
            placeholder="Passo a passo, mensagem de erro, horário…"
          />
        </Field>

        <Field label="Anexo (opcional)" hint="Imagem, PDF, documento, planilha, texto ou áudio — até 1,5 MB.">
          <input type="file" name="arquivo" className="campo" accept="image/*,application/pdf,text/*,.csv,.doc,.docx,.xls,.xlsx" />
        </Field>

        <div className="flex items-center justify-between gap-3 border-t border-nuvem-200 pt-3">
          <p className="text-xs text-stone-400">
            Aberto por <b className="text-stone-600">{user.name}</b>
          </p>
          <button type="submit" className="rounded-xl bg-marca-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-marca-700">
            Abrir chamado
          </button>
        </div>
      </form>

      <p className="text-xs text-stone-400">
        Também vale consultar o <Link href="/erros" className="text-marca-600 underline">Diário de erros</Link> antes —
        pode ser um problema já registrado pelo sistema.
      </p>
    </div>
  );
}
