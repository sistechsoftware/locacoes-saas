import { all } from "@/lib/db";
import Link from "next/link";
import FreightSettings from "./FreightSettings";
import ReciboSettings from "./ReciboSettings";
import FidelitySettings from "./FidelitySettings";
import BirthdaySettings from "./BirthdaySettings";
import { createPurpose, renamePurpose, todasFinalidades, togglePurpose } from "../financeiro/actions";
import { requireModule } from "@/lib/auth";
import { bloquearRecurso, temRecurso } from "@/lib/plano-gate";
import { listUsers } from "@/lib/auth";
import { ehAdmin } from "@/lib/roles";
import { limiteUsuarios, usuariosAtivos } from "@/lib/billing";
import { getSettings } from "@/lib/settings";
import { getOperacao } from "@/lib/operacao-db";
import OperacaoSettings from "./OperacaoSettings";
import { Alerta, Badge, Card, Empty, Field, Grid, PageHeader, Section } from "@/components/ui";
import { Tabs } from "@/components/List";
import { SubmitButton } from "@/components/SubmitButton";
import ImageInput from "@/components/ImageInput";
import EditorContrato from "@/components/EditorContrato";
import { addCategory, removeCategory, resetPassword, saveCompanySettings, saveFreightSettings, saveNavLayout, saveTemplates, toggleUser, updateUser, deleteUser } from "./actions";
import { getCompanySignature } from "@/lib/assinatura-empresa";
import AssinaturaEmpresa from "@/components/AssinaturaEmpresa";
import AvatarForm from "./AvatarForm";
import AvatarAdminForm from "./AvatarAdminForm";
import { saveVehicle, deleteVehicle } from "../operacao/actions";
import { createAccount, createSupplier, updateAccount } from "../compras/actions";
import { money } from "@/lib/format";
import UserForm from "./UserForm";
import PasswordForm from "./PasswordForm";
import CompletarCadastroForm from "./CompletarCadastroForm";
import { one } from "@/lib/db";
import { saveStockSettings } from "./actions";
import EmailSettings from "./EmailSettings";
import IdentidadeVisual from "./IdentidadeVisual";
import { resolverTema } from "@/lib/temas";
import { resolverConfigEmail } from "@/lib/email-notificacoes";
import { emailEstado } from "@/lib/email";

export const dynamic = "force-dynamic";

export default async function ConfiguracoesPage({
  searchParams,
}: {
  searchParams: Promise<{ aba?: string; erro?: string; ok?: string }>;
}) {
  /* company_id vem do contexto autenticado (nunca fallback de tenant). */
  const ctx = await requireModule("configuracoes");
  const user = ctx.user;
  const cid = ctx.companyId;
  /*
   * Administrador da Empresa = owner OU admin (ehAdmin).
   *
   * Aqui morava o bug da mensagem "Algumas configurações são restritas ao
   * administrador": a tela comparava `admin` literalmente, e
   * o DONO da empresa (role "owner", o administrador primário) era tratado
   * como operador — via a advertência e campos bloqueados, embora o backend
   * (assertAdmin) aceitasse as ações dele. A checagem única é a matriz de
   * papéis (roles.ts), não a comparação de string.
   */
  const admin = ehAdmin(user.role);
  const { aba = "empresa", erro, ok } = await searchParams;
  /*
   * Gate de APRESENTAÇÃO (mesma matriz do menu — planos.ts): abas de módulos
   * pagos fora do plano não existem nesta tela — Essencial fica sem Frete e
   * Fidelidade, Profissional sem Frete, e os modelos de contrato (aba Modelos)
   * aparecem só no Empresarial. URL direta (?aba=frete) cai na tela
   * explicativa /plano-restrito, como as páginas de módulo — em vez de exibir
   * configurações de um recurso que a empresa não contratou. A porta de
   * verdade continua no backend: o módulo em si é barrado por
   * requireModule/requireModuleEdit/apiUser, e a personalização administrativa
   * (liberação/cortesia) é respeitada porque temRecurso aplica a precedência
   * central — plataforma_admin segue sem restrição de plano.
   */
  const [temContratos, temFretes, temFidelidade, temLoja] = await Promise.all([
    temRecurso(user, "contratos"),
    temRecurso(user, "fretes"),
    temRecurso(user, "fidelidade"),
    temRecurso(user, "loja_virtual"),
  ]);
  if (aba === "frete" && !temFretes) bloquearRecurso("fretes", user, "configuracoes");
  if (aba === "fidelidade" && !temFidelidade) bloquearRecurso("fidelidade", user, "configuracoes");
  const s = await getSettings();
  /* Estado do provedor de e-mail (segredos RESEND_* no Worker) — só é consultado
     na aba Notificações, para o resumo mostrar o que impediria o envio. */
  const emailOk = aba === "notificacoes" ? (await emailEstado()) === "ok" : false;
  /* Configuração operacional (rótulos/visibilidade/perfil) — a aba Operação e a
     aba Fidelidade, que deriva o termo da recompensa do perfil selecionado. */
  const operacaoOperacional = aba === "operacao" || aba === "fidelidade" ? await getOperacao() : null;
  const categorias = await all<any>(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.company_id = c.company_id) AS produtos
       FROM categories c WHERE c.company_id = ? ORDER BY c.name`,
    [cid],
  );
  const vehicles = await all<any>(`SELECT * FROM vehicles WHERE company_id = ? ORDER BY active DESC, name`, [cid]);
  const fornecedores = await all<any>(
    `SELECT s.*, (SELECT COUNT(*) FROM purchases p WHERE p.supplier_id = s.id AND p.company_id = s.company_id) AS compras
       FROM suppliers s WHERE s.company_id = ? ORDER BY s.active DESC, s.name`,
    [cid],
  );
  // o saldo de cada conta e sempre recalculado a partir das movimentacoes,
  // nunca um numero guardado que pode divergir do extrato
  const contas =
    admin
      ? await all<any>(
          `SELECT a.*,
                  COALESCE((SELECT SUM(p.amount_cents) FROM payments p WHERE p.account_id = a.id),0) AS entradas,
                  COALESCE((SELECT SUM(e.amount_cents) FROM expenses e WHERE e.account_id = a.id),0) AS saidas
             FROM financial_accounts a WHERE a.company_id = ? ORDER BY a.active DESC, a.name`,
          [cid],
        )
      : [];
  const users = admin ? await listUsers() : [];
  // Identidade da PRÓPRIA sessão: alimenta o card de complemento cadastral
  // (contas antigas sem tipo/documento/e-mail — migração 0037 não supõe nada).
  const minhaIdentidade = await one<{ email: string | null; person_type: string | null; document: string | null }>(
    `SELECT email, person_type, document FROM users WHERE id = ? AND company_id = ?`,
    [user.id, cid],
  );
  const finalidades = admin ? await todasFinalidades() : [];
  // assinatura da empresa: so o admin (proprietario) ve e gerencia esta aba
  const assinaturaEmpresa = admin ? await getCompanySignature() : null;
  // uso do plano: limite e ocupação atuais, para a aba de usuários
  const [limitePlano, usuariosEmUso] = admin
    ? await Promise.all([limiteUsuarios(cid), usuariosAtivos(cid)])
    : [0, 0];

  const ABAS = [
    { value: "empresa", label: "Empresa" },
    { value: "navegacao", label: "Navegação" },
    ...(admin ? [{ value: "identidade", label: "Identidade visual" }] : []),
    { value: "modelos", label: "Modelos" },
    { value: "categorias", label: "Categorias" },
    { value: "veiculos", label: "Veículos" },
    { value: "fornecedores", label: "Fornecedores" },
    ...(admin ? [{ value: "contas", label: "Contas" }] : []),
    { value: "operacao", label: "Operação" },
    ...(temFretes ? [{ value: "frete", label: "Frete" }] : []),
    { value: "recibos", label: "Recibos" },
    { value: "disponibilidade", label: "Disponibilidade" },
    { value: "notificacoes", label: "Notificações" },
    ...(temFidelidade ? [{ value: "fidelidade", label: "Fidelidade" }] : []),
    ...(admin ? [{ value: "assinatura", label: "Assinatura" }] : []),
    { value: "aniversarios", label: "Aniversários" },
    ...(admin ? [{ value: "finalidades", label: "Finalidades" }] : []),
    ...(admin ? [{ value: "usuarios", label: "Usuários" }] : []),
    { value: "conta", label: "Minha conta" },
  ];

  return (
    <div className="space-y-4">
      <PageHeader title="Configurações" subtitle="Dados da empresa, modelos, usuários e permissões" />
      {erro && <Alerta tone="vermelho">{erro}</Alerta>}
      {ok && <Alerta tone="verde">{ok}</Alerta>}
      {!admin && aba !== "conta" && (
        <Alerta tone="ambar">
          Algumas configurações são restritas ao administrador. Você pode visualizar, mas não salvar alterações
          críticas.
        </Alerta>
      )}

      <Tabs items={ABAS} current={aba} base="/configuracoes" />

      {/* Loja Virtual: seção própria (catálogo, pedidos, Pix, publicação).
          Só aparece quando o recurso está liberado PARA ESTA empresa (plano
          Empresarial ou exceção administrativa) — a porta continua no backend. */}
      {temLoja && aba !== "conta" && (
        <Section title="Minha Loja Virtual">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-stone-600">
              Loja pública com seu catálogo, pedidos e orçamentos online — integrada às mesmas reservas, estoque e clientes de
              sempre.
            </p>
            <Link href="/configuracoes/loja" className="rounded-xl bg-marca-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-marca-700">
              Abrir Loja Virtual
            </Link>
          </div>
        </Section>
      )}

      {aba === "navegacao" && (
        <Section title="Layout de navegação">
          {/* O link de preferencias de notificacoes segue visivel para todos:
              era texto solto no topo desta pagina, aqui vira acesso da
              aba — ninguem perde o caminho. */}
          <p className="mb-3">
            <Link href="/notificacoes/preferencias" className="text-sm text-marca-600 underline">
              Notificações: dispositivos, funções operacionais e antecedentes
            </Link>
          </p>
          {admin ? (
            <>
              <p className="text-sm text-stone-600">
                Escolha como o menu principal é apresentado para toda a equipe. A troca é instantânea e pode ser
                revertida a qualquer momento — nenhum acesso, cadastro ou dado é afetado.
              </p>
              <form action={saveNavLayout} className="mt-3 space-y-3">
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-nuvem-300 bg-white px-3 py-3">
                  <input
                    type="radio"
                    name="nav_layout"
                    value="classico"
                    defaultChecked={s.nav_layout !== "agrupado"}
                    className="mt-1 h-4 w-4"
                  />
                  <span className="text-sm">
                    <b>Clássico</b> — menu único, como sempre foi
                    <span className="block text-xs text-stone-500">
                      Lista simples de Dashboard a Configurações, igual à versão atual do sistema.
                    </span>
                  </span>
                </label>
                <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-nuvem-300 bg-white px-3 py-3">
                  <input
                    type="radio"
                    name="nav_layout"
                    value="agrupado"
                    defaultChecked={s.nav_layout === "agrupado"}
                    className="mt-1 h-4 w-4"
                  />
                  <span className="text-sm">
                    <b>Agrupado</b> — menu organizado por contexto
                    <span className="block text-xs text-stone-500">
                      Mesmos destinos em grupos: Início, Operação (agenda, orçamentos, reservas, entregas, fretes),
                      Comercial (clientes, contratos, promoções, fidelidade, aniversários), Estoque, Gestão
                      (financeiro, assinatura, relatórios, histórico) e Sistema. No celular, o menu "Mais" ganha as
                      mesmas seções e o botão + deixa de ter o atalho Mensagens — o chat continua no sino do topo e
                      no menu.
                    </span>
                  </span>
                </label>
                <SubmitButton>Salvar Layout</SubmitButton>
              </form>
            </>
          ) : (
            <Alerta tone="ambar">A escolha do layout de navegação é exclusiva do administrador.</Alerta>
          )}
        </Section>
      )}

      {aba === "identidade" && admin && <IdentidadeVisual temaAtual={resolverTema(s.identidade_tema).id} />}

      {aba === "operacao" && operacaoOperacional && <OperacaoSettings inicial={operacaoOperacional} />}

      {aba === "disponibilidade" && <Section title="Preparação após Devolução">
        <form action={saveStockSettings} className="space-y-3">
          <Field label="Tempo de deslocamento e higienização (minutos)" hint="Exemplos: 30, 60, 90 ou 120. Zero desativa o acréscimo. Cada consulta permite considerar ou ignorar este tempo.">
            <input name="stock_preparation_minutes" type="number" min="0" max="10080" step="1" required defaultValue={s.stock_preparation_minutes} disabled={!admin} className="campo" />
          </Field>
          <p className="text-sm text-stone-500">Aplica-se aos intervalos das reservas que bloqueiam estoque. Cancelada, retirada e finalizada continuam sem bloqueio, conforme os status existentes. Alertas automáticos consideram o tempo configurado.</p>
          {admin && <SubmitButton>Salvar Configuração</SubmitButton>}
        </form>
      </Section>}

      {aba === "notificacoes" && (
        <EmailSettings
          inicial={resolverConfigEmail(s)}
          admin={admin}
          emailConfigurado={emailOk}
          temFidelidade={temFidelidade}
        />
      )}

      {aba === "empresa" && (
        <Section title="Dados da empresa">
          <form action={saveCompanySettings} className="space-y-3">
            <Grid>
              <Field label="Nome da empresa">
                <input name="company_name" defaultValue={s.company_name} className="campo" disabled={!admin} />
              </Field>
              <Field label="Subtítulo">
                <input name="company_tagline" defaultValue={s.company_tagline} className="campo" disabled={!admin} />
              </Field>
              <Field label="CNPJ / CPF">
                <input name="company_doc" defaultValue={s.company_doc} className="campo" disabled={!admin} />
              </Field>
              <Field label="Telefone">
                <input name="company_phone" defaultValue={s.company_phone} className="campo" disabled={!admin} />
              </Field>
              <Field label="WhatsApp">
                <input name="company_whatsapp" defaultValue={s.company_whatsapp} className="campo" disabled={!admin} />
              </Field>
              <Field label="E-mail">
                <input name="company_email" defaultValue={s.company_email} className="campo" disabled={!admin} />
              </Field>
              <Field label="Endereço">
                <input name="company_address" defaultValue={s.company_address} className="campo" disabled={!admin} />
              </Field>
              <Field label="Cidade">
                <input name="company_city" defaultValue={s.company_city} className="campo" disabled={!admin} />
              </Field>
              <Field label="Chave Pix">
                <input name="pix_key" defaultValue={s.pix_key} className="campo" disabled={!admin} />
              </Field>
              <Field label="Caução padrão (R$)">
                <input
                  name="default_deposit"
                  defaultValue={(Number(s.default_deposit_cents || 0) / 100).toFixed(2)}
                  inputMode="decimal"
                  className="campo"
                  disabled={!admin}
                />
              </Field>
              <Field
                label="Cobrança padrão dos produtos"
                hint="Produtos sem regra própria seguem esta modalidade. Por diária: valor × dias de calendário da janela."
              >
                <select
                  name="pricing_default_mode"
                  defaultValue={s.pricing_default_mode === "diaria" ? "diaria" : "fixo"}
                  className="campo"
                  disabled={!admin}
                >
                  <option value="fixo">Fixo (por unidade) — comportamento atual</option>
                  <option value="diaria">Por diária</option>
                </select>
              </Field>
              <Field
                label="Valor da hora extra (R$)"
                hint="Cobrado por hora cheia quando a retirada é estendida na edição, até o limite abaixo. Em 0 desliga."
              >
                <input
                  name="extra_hour_price"
                  defaultValue={(Number(s.extra_hour_price_cents || 0) / 100).toFixed(2)}
                  inputMode="decimal"
                  className="campo"
                  disabled={!admin}
                />
              </Field>
              <Field
                label="Horas extras que viram nova diária"
                hint="Extensão igual ou maior que isto não cobra hora extra automaticamente: a tela avisa e você decide se cobra diária adicional."
              >
                <input
                  name="extra_hours_until_daily"
                  type="number"
                  min={1}
                  step={1}
                  defaultValue={s.extra_hours_until_daily || "6"}
                  className="campo"
                  disabled={!admin}
                />
              </Field>
            </Grid>
            <Field label="Dados bancários">
              <textarea name="bank_info" defaultValue={s.bank_info} rows={2} className="campo" disabled={!admin} />
            </Field>
            <Field label="Logo da empresa">
              <div className="flex items-center gap-3">
                {s.company_logo && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.company_logo} alt="Logo" className="h-14 w-14 rounded-xl border border-nuvem-300 object-contain" />
                )}
                <ImageInput name="logo_file" disabled={!admin} />
              </div>
            </Field>
            {admin && <SubmitButton>Salvar Dados da Empresa</SubmitButton>}
          </form>
        </Section>
      )}

      {aba === "modelos" && (
        <Section title={temContratos ? "Modelos de contrato e WhatsApp" : "Modelos de WhatsApp"}>
          <form action={saveTemplates} className="space-y-4">
            {/* Contratos é item pago (empresarial+): fora do plano estes
                campos não existem na tela — e como o FormData vai sem eles,
                saveTemplates ignora os ausentes (nunca apaga o gravado). */}
            {temContratos && (
              <>
            <Field
              label="Modelo do contrato para impressão / termo de responsabilidade"
              hint="Usado apenas nos contratos impressos e assinados à mão. Use {{campo}} para inserir dados automaticamente e a barra acima para formatar (negrito, listas, alinhamento…)."
            >
              <EditorContrato name="contract_template" valorInicial={s.contract_template} disabled={!admin} />
            </Field>
            <Field
              label="Modelo do contrato digital (assinatura online)"
              hint="Usado apenas no link de assinatura digital que o cliente abre. Além dos campos do contrato impresso, aceita {{data_assinatura_digital}}, que vira “Uberlândia, 12 de setembro de 2026” na data em que o cliente abrir o contrato para assinar."
            >
              <EditorContrato name="contract_template_digital" valorInicial={s.contract_template_digital} disabled={!admin} />
            </Field>
            <p className="text-xs text-stone-500">
              Campos do contrato: {"{{cliente}}"}, {"{{cliente_doc}}"} (CPF/CNPJ), {"{{cliente_telefone}}"},{" "}
              {"{{cliente_email}}"}, {"{{cliente_endereco}}"}, {"{{cliente_bairro}}"}, {"{{cliente_cidade}}"},{" "}
              {"{{empresa}}"}, {"{{cnpj}}"}, {"{{endereco_empresa}}"}, {"{{telefone_empresa}}"},{" "}
              {"{{cidade_empresa}}"}, {"{{contrato}}"}, {"{{reserva}}"}, {"{{data_evento}}"},{" "}
              {"{{endereco_evento}}"}, {"{{itens}}"}, {"{{data_entrega}}"}, {"{{data_retirada}}"},{" "}
              {"{{valor_itens}}"}, {"{{valor_frete}}"}, {"{{valor_montagem}}"}, {"{{valor_desmontagem}}"},{" "}
              {"{{valor_outros}}"}, {"{{valor_desconto}}"}, {"{{valor_total}}"}, {"{{valor_caucao}}"},{" "}
              {"{{data_hoje}}"}. Um campo sem cadastro vira uma linha para preencher à mão no impresso.
            </p>
            <p className="text-xs text-stone-500">
              No modelo digital, além destes campos, está disponível a variável{" "}
              <b>{"{{data_assinatura_digital}}"}</b>, que o sistema preenche com “Uberlândia, 12 de setembro de 2026”
              na data em que o cliente abrir o contrato para assinar. A partir dessa abertura o texto fica congelado,
              exatamente como o cliente leu.
            </p>
              </>
            )}
            <Grid>
              <Field label="Mensagem de confirmação">
                <textarea name="wa_confirm" defaultValue={s.wa_confirm} rows={3} className="campo" disabled={!admin} />
              </Field>
              <Field label="Lembrete de entrega">
                <textarea name="wa_delivery" defaultValue={s.wa_delivery} rows={3} className="campo" disabled={!admin} />
              </Field>
              <Field label="Lembrete de retirada">
                <textarea name="wa_pickup" defaultValue={s.wa_pickup} rows={3} className="campo" disabled={!admin} />
              </Field>
              <Field label="Cobrança de pagamento">
                <textarea name="wa_payment" defaultValue={s.wa_payment} rows={3} className="campo" disabled={!admin} />
              </Field>
              <Field label="Envio de orçamento" className="sm:col-span-2">
                <textarea name="wa_quote" defaultValue={s.wa_quote} rows={3} className="campo" disabled={!admin} />
              </Field>
            </Grid>
            <p className="text-xs text-stone-500">
              Campos das mensagens de WhatsApp: {"{{cliente}}"}, {"{{empresa}}"}, {"{{reserva}}"},{" "}
              {"{{orcamento}}"}, {"{{data_evento}}"}, {"{{hora_entrega}}"}, {"{{hora_retirada}}"},{" "}
              {"{{endereco_evento}}"}, {"{{itens}}"}, {"{{valor_total}}"}, {"{{saldo}}"}, {"{{pix}}"}.
            </p>
            {admin && <SubmitButton>Salvar Modelos</SubmitButton>}
          </form>
        </Section>
      )}

      {aba === "categorias" && (
        <Section title="Categorias de produtos">
          <form action={addCategory} className="mb-3 flex gap-2">
            <input name="name" placeholder="Nova categoria" className="campo flex-1" required />
            <SubmitButton variant="secundario">Adicionar</SubmitButton>
          </form>
          {categorias.length === 0 ? (
            <Empty>Nenhuma categoria cadastrada.</Empty>
          ) : (
            <ul className="space-y-1.5">
              {categorias.map((c) => (
                <li key={c.id} className="flex items-center justify-between rounded-xl border border-nuvem-300 bg-white px-3 py-2.5">
                  <span className="text-sm font-medium">
                    {c.name} <span className="text-xs text-stone-400">({c.produtos} produto(s))</span>
                  </span>
                  {admin && (
                    <form action={removeCategory}>
                      <input type="hidden" name="id" value={c.id} />
                      <SubmitButton variant="perigo" className="px-2 py-1 text-xs" confirm={`Remover a categoria ${c.name}?`}>
                        Remover
                      </SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {aba === "veiculos" && (
        <Section title="Veículos">
          <form action={saveVehicle} className="mb-4 grid grid-cols-2 gap-2">
            <input name="name" placeholder="Nome (ex.: Carro + carretinha) *" className="campo col-span-2" required />
            <input name="plate" placeholder="Placa" className="campo" />
            <input name="model" placeholder="Modelo" className="campo" />
            <input name="capacity" placeholder="Capacidade" className="campo" />
            <input name="notes" placeholder="Observações" className="campo" />
            <div className="col-span-2">
              <SubmitButton variant="secundario" className="w-full">
                Adicionar Veículo
              </SubmitButton>
            </div>
          </form>
          {vehicles.length === 0 ? (
            <Empty>Nenhum veículo cadastrado.</Empty>
          ) : (
            <ul className="space-y-1.5">
              {vehicles.map((v) => (
                <li key={v.id} className="flex items-center justify-between rounded-xl border border-nuvem-300 bg-white px-3 py-2.5">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">
                      {v.name} {!v.active && <Badge tone="cinza">Inativo</Badge>}
                    </span>
                    <span className="block text-xs text-stone-500">
                      {[v.plate, v.model, v.capacity].filter(Boolean).join(" - ")}
                    </span>
                  </span>
                  {admin && (
                    <form action={deleteVehicle}>
                      <input type="hidden" name="id" value={v.id} />
                      <SubmitButton variant="perigo" className="px-2 py-1 text-xs" confirm={`Remover ${v.name}?`}>
                        Remover
                      </SubmitButton>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {aba === "frete" && <FreightSettings settings={s} admin={admin} />}

      {aba === "recibos" && <ReciboSettings settings={s} admin={admin} />}

      {aba === "fidelidade" && (
        <FidelitySettings settings={s} admin={admin} perfil={operacaoOperacional?.perfil ?? "festas"} />
      )}

      {aba === "assinatura" && admin && (
        <Section title="Assinatura digital da empresa">
          <p className="mb-3 text-sm text-stone-600">
            Cadastre sua assinatura para utilizá-la automaticamente em novos contratos e recibos. Documentos já gerados
            permanecem exatamente como estão.
          </p>
          <AssinaturaEmpresa
            url={assinaturaEmpresa?.url ?? null}
            atualizadaEm={assinaturaEmpresa?.atualizada_em ?? null}
          />
        </Section>
      )}

      {aba === "aniversarios" && <BirthdaySettings settings={s} admin={admin} />}

      {aba === "finalidades" && admin && (
        <Section title="Finalidades das Saídas">
          <p className="mb-3 text-sm text-stone-600">
            São as opções que aparecem ao lançar uma saída no Financeiro. Desativar ou renomear uma finalidade{" "}
            <b>não altera nenhum lançamento já registrado</b>: cada saída guarda o texto escolhido no dia.
          </p>

          <form action={createPurpose} className="mb-4 pilha-filtros">
            <input type="hidden" name="aba" value="finalidades" />
            <input name="name" placeholder="Nova finalidade" maxLength={60} required className="campo min-w-0 flex-1 basis-48" />
            <SubmitButton>Adicionar</SubmitButton>
          </form>

          {finalidades.length === 0 ? (
            <Empty>Nenhuma finalidade cadastrada.</Empty>
          ) : (
            <ul className="divide-y divide-nuvem-200">
              {/* Mobile: o grupo da direita (sem uso + badge + Desativar) é
                  shrink-0 e sozinho leva ~210px; com o form em flex-1/basis-0
                  o <li> nunca quebrava a linha e o input do nome ficava com
                  ~45px — so dava pra ler "Cc", "Dv"... Abaixo de 640px as duas
                  metades empilham e o nome ocupa a linha inteira; de sm em
                  diante continua como antes. */}
              {finalidades.map((f: any) => (
                <li key={f.id} className="flex flex-col gap-2 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                  <form action={renamePurpose} className="flex min-w-0 items-center gap-2 sm:flex-1">
                    <input type="hidden" name="id" value={f.id} />
                    <input
                      name="name"
                      defaultValue={f.name}
                      maxLength={60}
                      className="campo min-w-0 flex-1"
                      aria-label={`Nome da finalidade ${f.name}`}
                    />
                    <SubmitButton variant="secundario" className="px-2.5 py-1.5 text-xs">
                      Renomear
                    </SubmitButton>
                  </form>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="text-xs text-stone-500">
                      {f.usos > 0 ? `${f.usos} saída(s)` : "sem uso"}
                    </span>
                    {f.active ? <Badge tone="verde">ativa</Badge> : <Badge tone="cinza">inativa</Badge>}
                    <form action={togglePurpose}>
                      <input type="hidden" name="id" value={f.id} />
                      <SubmitButton
                        variant="secundario"
                        className="px-2.5 py-1.5 text-xs"
                        confirm={
                          f.active
                            ? `Desativar "${f.name}"? Ela some das opções de novos lançamentos, e as ${f.usos} saída(s) já registradas continuam intactas.`
                            : undefined
                        }
                      >
                        {f.active ? "Desativar" : "Reativar"}
                      </SubmitButton>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {aba === "fornecedores" && (
        <Section title="Fornecedores">
          <form action={createSupplier} className="mb-4 grid grid-cols-2 gap-2">
            <input name="name" placeholder="Nome do fornecedor *" className="campo col-span-2" required />
            <input name="doc" placeholder="CNPJ / CPF" className="campo" />
            <input name="phone" placeholder="Telefone" className="campo" />
            <input name="email" placeholder="E-mail" className="campo" />
            <input name="notes" placeholder="Observações" className="campo" />
            <div className="col-span-2">
              <SubmitButton variant="secundario" className="w-full">
                Adicionar Fornecedor
              </SubmitButton>
            </div>
          </form>
          {fornecedores.length === 0 ? (
            <Empty>Nenhum fornecedor cadastrado. Eles aparecem no seletor da compra.</Empty>
          ) : (
            <ul className="space-y-1.5">
              {fornecedores.map((f: any) => (
                <li
                  key={f.id}
                  className="flex items-center justify-between rounded-xl border border-nuvem-300 bg-white px-3 py-2.5"
                >
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-tinta-900">
                      {f.name} {!f.active && <Badge tone="cinza">Inativo</Badge>}
                    </span>
                    <span className="block text-xs text-stone-500">
                      {[f.doc, f.phone, f.email].filter(Boolean).join(" - ") || "sem contato"}
                      {f.compras > 0 ? ` · ${f.compras} compra(s)` : ""}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      {aba === "contas" && admin && (
        <Section title="Contas financeiras">
          <form action={createAccount} className="mb-4 grid grid-cols-2 gap-2">
            <input name="name" placeholder="Nome da conta *" className="campo col-span-2" required />
            <select name="kind" defaultValue="banco" className="campo">
              <option value="banco">Conta corrente</option>
              <option value="dinheiro">Dinheiro</option>
              <option value="digital">Conta digital</option>
              <option value="poupanca">Poupança</option>
              <option value="outro">Outra</option>
            </select>
            <input name="bank" placeholder="Banco" className="campo" />
            <input name="initial_balance" placeholder="Saldo inicial (R$)" inputMode="decimal" className="campo" />
            <input name="notes" placeholder="Observações" className="campo" />
            <label className="col-span-2 flex items-center gap-2 text-sm text-stone-700">
              <input type="checkbox" name="is_cash_account" value="1" className="h-4 w-4" />
              <span>
                Esta conta representa <b>dinheiro em espécie</b>
                <span className="block text-xs text-stone-500">
                  Marque para carteira física, caixa ou dinheiro em mãos. A conta funciona igual a qualquer outra:
                  recebe lançamentos, participa de transferências e entra no saldo.
                </span>
              </span>
            </label>
            <div className="col-span-2">
              <SubmitButton variant="secundario" className="w-full">
                Adicionar Conta
              </SubmitButton>
            </div>
          </form>
          {contas.length === 0 ? (
            <Empty>
              Nenhuma conta cadastrada. Cadastre ao menos uma para saber de qual conta cada pagamento saiu.
            </Empty>
          ) : (
            <ul className="space-y-1.5">
              {contas.map((c: any) => {
                const saldo = c.initial_balance_cents + c.entradas - c.saidas;
                return (
                  <li key={c.id} className="rounded-xl border border-nuvem-300 bg-white px-3 py-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold text-tinta-900">
                          {c.name} {c.is_cash_account ? <Badge tone="terracota">Dinheiro em espécie</Badge> : null}{" "}
                          {!c.active && <Badge tone="cinza">Inativa</Badge>}
                        </span>
                        <span className="block text-xs text-stone-500">
                          {c.kind}
                          {c.bank ? ` · ${c.bank}` : ""} · inicial {money(c.initial_balance_cents)}
                        </span>
                      </span>
                      <span className={`shrink-0 text-sm font-bold ${saldo < 0 ? "text-red-600" : "text-tinta-900"}`}>
                        {money(saldo)}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-stone-500">
                      entradas {money(c.entradas)} · saídas {money(c.saidas)}
                    </p>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-semibold text-marca-600">Editar conta</summary>
                      {/* As duas caixas do mesmo form viajam juntas: desmarcar a
                          opção remove a marca em vez de manter o valor antigo. */}
                      <form action={updateAccount} className="mt-2 grid grid-cols-2 gap-2">
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="is_cash_account_presente" value="1" />
                        <input name="name" defaultValue={c.name} placeholder="Nome da conta *" className="campo col-span-2" required />
                        <select name="kind" defaultValue={c.kind} className="campo">
                          <option value="banco">Conta corrente</option>
                          <option value="dinheiro">Dinheiro</option>
                          <option value="digital">Conta digital</option>
                          <option value="poupanca">Poupança</option>
                          <option value="outro">Outra</option>
                        </select>
                        <input name="bank" defaultValue={c.bank ?? ""} placeholder="Banco" className="campo" />
                        <input
                          name="initial_balance"
                          defaultValue={(Number(c.initial_balance_cents || 0) / 100).toFixed(2)}
                          placeholder="Saldo inicial (R$)"
                          inputMode="decimal"
                          className="campo"
                        />
                        <input name="notes" defaultValue={c.notes ?? ""} placeholder="Observações" className="campo" />
                        <label className="col-span-2 flex items-center gap-2 text-sm text-stone-700">
                          <input
                            type="checkbox"
                            name="is_cash_account"
                            value="1"
                            defaultChecked={!!c.is_cash_account}
                            className="h-4 w-4"
                          />
                          <span>
                            Esta conta representa <b>dinheiro em espécie</b>
                          </span>
                        </label>
                        <div className="col-span-2">
                          <SubmitButton variant="secundario" className="w-full">
                            Salvar Conta
                          </SubmitButton>
                        </div>
                      </form>
                      <p className="mt-1 text-xs text-stone-500">
                        Editar o saldo inicial não altera lançamentos antigos: ele entra na conta do saldo junto com o
                        que já foi movimentado.
                      </p>
                    </details>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="mt-2 text-xs text-stone-500">
            O saldo é recalculado a partir das movimentações, nunca guardado, para não divergir do extrato.
          </p>
        </Section>
      )}

      {aba === "usuarios" && admin && (
        <div className="space-y-4">
          <Section title="Plano e limite de usuários">
            <p className="text-sm text-stone-600">
              <b className="text-tinta-900">{usuariosEmUso}</b> de <b className="text-tinta-900">{limitePlano}</b> usuário(s)
              ativo(s) no plano atual. A vaga é liberada ao inativar ou excluir um usuário — a regra é validada no
              servidor, não apenas nesta tela.
            </p>
            {usuariosEmUso >= limitePlano && (
              <Alerta tone="ambar">
                Limite do plano atingido. Para criar outro usuário, inative ou exclua um existente, ou faça upgrade em
                /faturamento.
              </Alerta>
            )}
          </Section>
          <Section title="Novo Usuário">
            <UserForm />
          </Section>
          <Section title="Usuários do Sistema">
            <ul className="space-y-1.5">
              {users.map((u: any) => (
                <li key={u.id} className="rounded-xl border border-nuvem-300 bg-white p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      <span className="text-sm font-bold text-tinta-900">{u.name}</span>
                      <span className="ml-2 text-xs text-stone-500">@{u.username}</span>
                      <Badge tone={u.role === "admin" ? "terracota" : "cinza"} className="ml-2">
                        {u.role}
                      </Badge>
                      {!u.active && <Badge tone="vermelho" className="ml-1">Inativo</Badge>}
                    </span>
                    <div className="flex items-center gap-2">
                      {u.id !== user.id && (
                        <form action={toggleUser}>
                          <input type="hidden" name="id" value={u.id} />
                          <SubmitButton variant="secundario" className="px-2.5 py-1 text-xs">
                            {u.active ? "Inativar" : "Reativar"}
                          </SubmitButton>
                        </form>
                      )}
                      {u.role !== "owner" && u.id !== user.id && (
                        <form action={deleteUser}>
                          <input type="hidden" name="id" value={u.id} />
                          <SubmitButton
                            variant="perigo"
                            className="px-2.5 py-1 text-xs"
                            confirm={`Excluir definitivamente o usuário ${u.name}? A vaga do plano é liberada; usuários com histórico (mensagens, pagamentos, reservas) devem ser inativados em vez de excluídos.`}
                          >
                            Excluir
                          </SubmitButton>
                        </form>
                      )}
                    </div>
                  </div>
                  {/* Foto de perfil: o admin troca/remove; o proprio usuario
                      tambem pode pela aba Minha conta. */}
                  <div className="mt-2">
                    <AvatarAdminForm userId={u.id} userName={u.name} url={u.avatar_url} />
                  </div>
                  {u.role !== "owner" && u.id !== user.id && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs font-semibold text-marca-600">Editar usuário</summary>
                      <form action={updateUser} className="mt-2 grid gap-2 sm:grid-cols-2">
                        <input type="hidden" name="id" value={u.id} />
                        <input name="name" defaultValue={u.name} placeholder="Nome" className="campo" required />
                        <input name="username" defaultValue={u.username} placeholder="Usuário de login" className="campo" required />
                        <input name="email" defaultValue={u.email} placeholder="E-mail" type="email" className="campo" />
                        <input name="phone" defaultValue={u.phone} placeholder="Telefone" className="campo" />
                        <select name="role" defaultValue={u.role} className="campo">
                          <option value="admin">Administrador</option>
                          <option value="operacional">Operador</option>
                        </select>
                        <SubmitButton variant="secundario">Salvar Alterações</SubmitButton>
                      </form>
                    </details>
                  )}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs font-semibold text-marca-600">Redefinir senha</summary>
                    <form action={resetPassword} className="mt-2 flex gap-2">
                      <input type="hidden" name="id" value={u.id} />
                      <input name="password" type="password" placeholder="Nova senha" minLength={6} className="campo" required />
                      <SubmitButton variant="secundario" className="shrink-0">
                        Salvar
                      </SubmitButton>
                    </form>
                  </details>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-stone-500">
              Operadores acessam reservas, clientes, estoque, agenda e financeiro do dia a dia, mas não podem excluir
              registros nem alterar configurações críticas da empresa. O proprietário da empresa (owner) não pode ser
              inativado, excluído nem rebaixado por esta tela.
            </p>
          </Section>
        </div>
      )}

      {aba === "conta" && (
        <Section title="Minha conta">
          <p className="mb-3 text-sm text-stone-600">
            {user.name} · perfil <b className="capitalize">{user.role}</b>
          </p>
          <AvatarForm url={user.avatar_url} name={user.name} />
          <PasswordForm />
          {((user.role === "owner" && (!minhaIdentidade?.person_type || !minhaIdentidade?.document)) ||
            !minhaIdentidade?.email) && (
            <CompletarCadastroForm
              semDocumento={
                user.role === "owner" && (!minhaIdentidade?.person_type || !minhaIdentidade?.document)
              }
              semEmail={!minhaIdentidade?.email}
            />
          )}
        </Section>
      )}
    </div>
  );
}
