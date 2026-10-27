import { requireModule } from "@/lib/auth";
import { temRecurso, bloquearRecurso, registrarNegacao } from "@/lib/plano-gate";
import { lojaDaEmpresa } from "@/lib/loja-db";
import { Alerta, Field, Grid, PageHeader, Section, BTN } from "@/components/ui";
import { salvarPixAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function PixLojaPage({ searchParams }: { searchParams: Promise<{ erro?: string; ok?: string }> }) {
  const ctx = await requireModule("configuracoes");
  if (!(await temRecurso(ctx.user, "loja_virtual"))) {
    registrarNegacao(ctx.companyId, "loja_virtual", "pagina-loja");
    bloquearRecurso("loja_virtual", ctx.user, "pagina");
  }
  const { erro, ok } = await searchParams;
  const l = await lojaDaEmpresa(ctx.companyId);
  const exigeSinal = (l?.signal_percent ?? 0) > 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Pagamento por Pix"
        subtitle="O dinheiro entra direto na sua conta: a loja mostra seus dados, o valor exato do pedido e o código copia-e-cola."
      />
      {erro && <Alerta tone="vermelho">{erro}</Alerta>}
      {ok && <Alerta tone="verde">{ok}</Alerta>}

      {exigeSinal && !(l?.pix_enabled && l.pix_key) && (
        <Alerta tone="ambar" title="Sinal obrigatório sem Pix">
          Você exige sinal, mas ainda não habilitou o Pix da loja. Sem isso, o QR Code e a chave não aparecem para o cliente.
        </Alerta>
      )}

      <form action={salvarPixAction} className="space-y-4">
        <Section title="Recebimento">
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" name="pix_enabled" defaultChecked={l?.pix_enabled === 1} />
            Exibir dados Pix na loja e na página de acompanhamento
          </label>
          <Grid>
            <Field label="Chave Pix" hint="Chave da SUA conta: CPF, CNPJ, e-mail, telefone ou chave aleatória.">
              <input name="pix_key" className="campo" defaultValue={l?.pix_key ?? ""} maxLength={120} />
            </Field>
            <Field label="Nome do recebedor" hint="Aparece no copia-e-cola (até 25 caracteres).">
              <input name="pix_holder" className="campo" defaultValue={l?.pix_holder ?? ""} maxLength={80} />
            </Field>
            <Field label="Cidade do recebedor" hint="Obrigatória no padrão Pix (até 15 caracteres).">
              <input name="pix_city" className="campo" defaultValue={l?.pix_city ?? l?.city ?? ""} maxLength={40} />
            </Field>
            <Field label="Instituição financeira">
              <input name="pix_institution" className="campo" defaultValue={l?.pix_institution ?? ""} maxLength={80} />
            </Field>
          </Grid>
          <div className="mt-3">
            <Field label="Instruções de pagamento" hint="Ex.: “Após pagar, envie o comprovante nesta página.”">
              <textarea name="pix_instructions" className="campo" rows={3} maxLength={2000} defaultValue={l?.pix_instructions ?? ""} />
            </Field>
          </div>
        </Section>

        <Section title="Como funciona">
          <ul className="list-disc space-y-1 pl-5 text-sm text-stone-600">
            <li>O cliente vê a chave, o botão de copiar e o código Pix com o valor EXATO do pedido (gerado pelo servidor no envio).</li>
            <li>Enviar comprovante nunca confirma pagamento: o pedido fica “comprovante enviado” e você confirma ou recusa no painel.</li>
            <li>O Locô não guarda, divide nem transfere valores — o recebimento é da sua conta.</li>
            <li>A chave só aparece na loja quando a exibição acima está habilitada, e nunca vazou para outra empresa.</li>
          </ul>
        </Section>

        <div className="flex justify-end">
          <button type="submit" className={BTN.primario}>
            Salvar dados Pix
          </button>
        </div>
      </form>
    </div>
  );
}
