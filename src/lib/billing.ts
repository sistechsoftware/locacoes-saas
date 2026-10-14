/**
 * Camada comercial do SaaS (Etapa 3): planos, assinatura, trial, cobrança
 * via Asaas — Pix, cartão e boleto (sandbox/produção por secrets) e
 * inadimplência.
 *
 * Regras de projeto:
 *  * Toda função recebe/exige o company_id explicitamente — esta camada é da
 *    PLATAFORMA e não depende de sessão (cron, telas e testes a chamam do
 *    mesmo jeito). Nenhum company_id vem do frontend: as telas pegam o valor
 *    do contexto autenticado.
 *  * Sem Asaas configurado o sistema segue funcionando: trial e bloqueio
 *    operam localmente; gerar cobrança apenas reporta que falta integração.
 *  * Status de assinatura: trial | active | past_due | suspended | canceled.
 */

import { all, insert, one, run, scalar } from "./db";
import {
  AsaasError,
  asaasClient,
  asaasEnvironment,
  ehMeioCobranca,
  ASAAS_SANDBOX,
  ASAAS_PRODUCAO,
  type AsaasPayment,
  type MeioCobranca,
} from "./asaas";
import {
  emailCobrancaGerada,
  emailPagamentoConfirmado,
  emailTrialExpirado,
  emailTrialExpirando,
  enviarEmail,
  publicUrlDaPlataforma,
} from "./email";

function dinheiroFmt(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export type SubscriptionStatus = "trial" | "active" | "past_due" | "suspended" | "canceled";

export type Plan = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  price_cents: number;
  max_users: number;
  trial_days: number;
  active: number;
};

export type Subscription = {
  id: number;
  company_id: number;
  plan_id: number;
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  payment_method: string | null;
  asaas_customer_id: string | null;
  asaas_subscription_id: string | null;
};

export const STATUS_ROTULO: Record<SubscriptionStatus, string> = {
  trial: "Em avaliação",
  active: "Ativa",
  past_due: "Pagamento em atraso",
  suspended: "Suspensa",
  canceled: "Cancelada",
};

/* ------------------------------------------------------------------ */
/* Datas — meio-dia UTC evita borda de fuso em comparações por dia      */
/* ------------------------------------------------------------------ */

function meioDiaUTC(iso: string): number {
  return Date.parse(`${iso.slice(0, 10)}T12:00:00Z`);
}

function diaISO(offsetDays: number, base?: string): string {
  const baseMs = base ? meioDiaUTC(base) : Date.now();
  return new Date(baseMs + offsetDays * 86400000).toISOString().slice(0, 10);
}

function hojeISO(): string {
  // Dia de hoje no fuso de Brasília (o sistema opera em America/Sao_Paulo).
  return new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Catálogo                                                             */
/* ------------------------------------------------------------------ */

export async function listarPlanos(): Promise<Plan[]> {
  return await all<Plan>(`SELECT * FROM plans WHERE active = 1 ORDER BY sort_order, id`);
}

export async function planoPorSlug(slug: string): Promise<Plan | undefined> {
  return await one<Plan>(`SELECT * FROM plans WHERE slug = ? AND active = 1`, [slug]);
}

/* ------------------------------------------------------------------ */
/* Assinatura da empresa                                                */
/* ------------------------------------------------------------------ */

/**
 * Assinatura da empresa, criando o trial automaticamente na primeira
 * consulta se a empresa ainda não tiver nenhuma (instalação nova ou empresa
 * recém-criada pelo painel/checkout). `planoSlug` fixa o plano inicial — é o
 * que o checkout público usa para o trial nascer no plano contratado; sem
 * ele vale o primeiro do catálogo (comportamento antigo). Nunca lança: sem
 * planos ativos no catálogo, devolve null e a camada comercial trata a
 * ausência.
 */
export async function assinaturaDaEmpresa(companyId: number, planoSlug?: string): Promise<Subscription | null> {
  const atual = await one<Subscription>(`SELECT * FROM subscriptions WHERE company_id = ?`, [companyId]);
  if (atual) return atual;

  const plano = planoSlug
    ? await one<Plan>(`SELECT * FROM plans WHERE slug = ? AND active = 1`, [planoSlug])
    : await one<Plan>(
        `SELECT * FROM plans WHERE active = 1 ORDER BY sort_order, id LIMIT 1`,
      );
  if (!plano) return null;

  const hoje = hojeISO();
  const id = await insert(
    `INSERT INTO subscriptions (company_id, plan_id, status, trial_ends_at, current_period_start, current_period_end)
     VALUES (?,?,?,?,?,?)`,
    [companyId, plano.id, "trial", diaISO(plano.trial_days, hoje), hoje, diaISO(plano.trial_days, hoje)],
  );
  return (await one<Subscription>(`SELECT * FROM subscriptions WHERE id = ?`, [id]))!;
}

/** Troca de plano (upgrade/downgrade) — recalcula o fim do período vigente. */
export async function trocarPlano(companyId: number, planSlug: string): Promise<Subscription> {
  const plano = await planoPorSlug(planSlug);
  if (!plano) throw new Error("Plano inexistente ou inativo.");
  const sub = await assinaturaDaEmpresa(companyId);
  if (!sub) throw new Error("Instalação sem planos configurados.");
  if (sub.status === "canceled") throw new Error("Assinatura cancelada: reative antes de trocar o plano.");

  const fimAtual = sub.current_period_end ?? diaISO(plano.trial_days);
  await run(
    `UPDATE subscriptions SET plan_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
    [plano.id, sub.id],
  );
  void fimAtual;
  return (await one<Subscription>(`SELECT * FROM subscriptions WHERE company_id = ?`, [companyId]))!;
}

/** Limite de usuários do plano vigente (para cadastro de usuários). */
export async function limiteUsuarios(companyId: number): Promise<number> {
  const sub = await assinaturaDaEmpresa(companyId);
  if (!sub) return 3;
  const plano = await one<Plan>(`SELECT * FROM plans WHERE id = ?`, [sub.plan_id]);
  return plano?.max_users ?? 3;
}

/** Usuários ativos da empresa — é isto que ocupa vaga do plano. */
export async function usuariosAtivos(companyId: number): Promise<number> {
  return await scalar<number>(`SELECT COUNT(*) FROM users WHERE company_id = ? AND active = 1`, [companyId]);
}

/**
 * Verificação do limite de usuários, usada na CRIAÇÃO no backend.
 *
 * Regra: apenas usuários ATIVOS contam (inativado/excluído libera a vaga na
 * hora). Server-side e independente de interface — chamar a action direto
 * não furta o limite.
 */
export async function podeCriarUsuario(
  companyId: number,
): Promise<{ ok: boolean; limite: number; atuais: number; motivo?: string }> {
  const [limite, atuais] = await Promise.all([limiteUsuarios(companyId), usuariosAtivos(companyId)]);
  if (atuais >= limite) {
    return { ok: false, limite, atuais, motivo: `Limite do plano atingido (${limite} usuários ativos). Faça upgrade em Assinatura.` };
  }
  return { ok: true, limite, atuais };
}

/* ------------------------------------------------------------------ */
/* Estado efetivo — o que as telas e o gate consomem                    */
/* ------------------------------------------------------------------ */

export type EstadoAssinatura = {
  status: SubscriptionStatus;
  rotulo: string;
  /** A empresa pode usar o sistema normalmente? */
  bloqueada: boolean;
  /** Bloqueio severo (não é só aviso): trial expirado, suspenso, cancelado. */
  bloqueioDuro: boolean;
  trial_ends_at: string | null;
  current_period_end: string | null;
  diasRestantes: number | null;
  avisoVencimento: boolean;
  /**
   * Plano contratado. `slug` é o identificador ESTÁVEL (essencial |
   * profissional | empresarial) — é ele que alimenta o gate de recursos
   * (plano-gate.ts); nome e preço são só exibição.
   */
  plano: { slug: string; name: string; price_cents: number; max_users: number } | null;
};

export async function estadoAssinatura(companyId: number): Promise<EstadoAssinatura> {
  const sub = await assinaturaDaEmpresa(companyId);
  if (!sub) {
    return {
      status: "trial",
      rotulo: STATUS_ROTULO.trial,
      bloqueada: false,
      bloqueioDuro: false,
      trial_ends_at: null,
      current_period_end: null,
      diasRestantes: null,
      avisoVencimento: false,
      plano: null,
    };
  }
  const plano = await one<Plan>(`SELECT * FROM plans WHERE id = ?`, [sub.plan_id]);
  const hoje = hojeISO();

  // Estados terminais/definidos por evento valem como estão.
  if (sub.status === "suspended" || sub.status === "canceled") {
    return {
      status: sub.status,
      rotulo: STATUS_ROTULO[sub.status],
      bloqueada: true,
      bloqueioDuro: true,
      trial_ends_at: sub.trial_ends_at,
      current_period_end: sub.current_period_end,
      diasRestantes: null,
      avisoVencimento: false,
      plano: plano ?? null,
    };
  }

  if (sub.status === "trial") {
    const fim = sub.trial_ends_at;
    const restantes = fim ? Math.ceil((meioDiaUTC(fim) - meioDiaUTC(hoje)) / 86400000) : null;
    const expirou = fim !== null && meioDiaUTC(hoje) > meioDiaUTC(fim);
    return {
      status: "trial",
      rotulo: STATUS_ROTULO.trial,
      bloqueada: expirou,
      bloqueioDuro: expirou,
      trial_ends_at: fim,
      current_period_end: sub.current_period_end,
      diasRestantes: restantes,
      avisoVencimento: restantes !== null && restantes <= 3 && restantes >= 0,
      plano: plano ?? null,
    };
  }

  // active | past_due: período vencido entra em TOLERÂNCIA (past_due) — a
  // suspensão (bloqueio duro) acontece só quando a cobrança em aberto passa
  // de LIMITE_TOLERANCIA_DIAS, decisão da rotina diária, nunca aqui. Assim um
  // webhook atrasado nunca bloqueia a operação antes da hora.
  const fim = sub.current_period_end;
  const venceu = fim !== null && meioDiaUTC(hoje) > meioDiaUTC(fim);
  const statusEfetivo: SubscriptionStatus = sub.status === "past_due" || venceu ? "past_due" : "active";
  const restantes = fim ? Math.ceil((meioDiaUTC(fim) - meioDiaUTC(hoje)) / 86400000) : null;
  return {
    status: statusEfetivo,
    rotulo: STATUS_ROTULO[statusEfetivo],
    bloqueada: false,
    bloqueioDuro: false,
    trial_ends_at: sub.trial_ends_at,
    current_period_end: fim,
    diasRestantes: restantes,
    avisoVencimento: statusEfetivo === "active" && restantes !== null && restantes <= 5,
    plano: plano ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Cobrança via Asaas (Pix, cartão e boleto)                           */
/* ------------------------------------------------------------------ */

const LIMITE_TOLERANCIA_DIAS = 7;

/**
 * Valida CPF (11 dígitos) e CNPJ (14 dígitos) pelos dígitos verificadores.
 *
 * O Asaas rejeita documento malformado com erro genérico ("CPF/CNPJ informado
 * é inválido"), então a barreira fica aqui — antes da chamada — para a tela
 * poder instruir o usuário em vez de devolver "tente novamente".
 */
export function documentoValido(valor: string): boolean {
  const doc = (valor ?? "").replace(/\D/g, "");
  const digito = (base: string, pesos: number[]): number => {
    const soma = base.split("").reduce((acc, d, i) => acc + Number(d) * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  if (doc.length === 11) {
    if (/^(\d)\1{10}$/.test(doc)) return false;
    return (
      digito(doc.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(doc[9]) &&
      digito(doc.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(doc[10])
    );
  }
  if (doc.length === 14) {
    if (/^(\d)\1{13}$/.test(doc)) return false;
    return (
      digito(doc.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(doc[12]) &&
      digito(doc.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(doc[13])
    );
  }
  return false;
}

/**
 * Gancho de teste (mesmo padrão de globalThis.__limasTestDb em db.ts): define
 * o cliente Asaas usado por gerarCobrancaPeriodo sem tocar em secrets/rede.
 * Em produção permanece null e o módulo usa o ambiente real do Worker.
 */
let asaasTeste: { apiKey: string; baseUrl: string; fetchImpl?: typeof fetch } | null = null;
export function __definirAsaasTeste(cfg: { apiKey: string; baseUrl: string; fetchImpl?: typeof fetch } | null) {
  asaasTeste = cfg;
}

function proximoVencimento(base?: string): string {
  return diaISO(30, base);
}

/** Datas (YYYY-MM-DD) do período coberto pela próxima cobrança. */
function periodoDaCobranca(sub: Subscription): { vencimento: string; periodStart: string; periodEnd: string } {
  const periodStart = sub.current_period_end ?? diaISO(0);
  return {
    vencimento: proximoVencimento(sub.current_period_end ?? undefined),
    periodStart,
    periodEnd: diaISO(30, periodStart),
  };
}

/**
 * Grava o espelho local da cobrança criada no Asaas (idempotente pelo
 * asaas_payment_id UNIQUE — uma falha depois do INSERT não regrava).
 */
async function registrarCobrancaLocal(
  companyId: number,
  subscriptionId: number,
  payment: AsaasPayment,
  amountCents: number,
  dueDate: string,
  periodStart: string,
  periodEnd: string,
): Promise<void> {
  await insert(
    `INSERT INTO subscription_payments
       (company_id, subscription_id, asaas_payment_id, amount_cents, billing_type, status, due_date, period_start, period_end, invoice_url)
     VALUES (?,?,?,?,?,'pending',?,?,?,?)`,
    [
      companyId,
      subscriptionId,
      payment.id,
      amountCents,
      payment.billingType || "PIX",
      dueDate,
      periodStart,
      periodEnd,
      payment.invoiceUrl ?? null,
    ],
  );
}

/**
 * Gera a cobrança do próximo período.
 *
 * Fluxo: garante assinatura -> garante cliente no Asaas (externalReference
 * `company:<id>`) -> cria o payment com o meio pedido -> registra em
 * subscription_payments com o período coberto.
 *
 * Meio de pagamento (`opts.meio`, padrão UNDEFINED):
 *  * UNDEFINED — a fatura do Asaas deixa o pagador escolher entre os meios
 *    habilitados na conta (Pix, cartão, boleto). É o padrão, inclusive para
 *    a rotina diária, para que TODAS as cobranças ofereçam os meios da conta;
 *    se o Asaas recusar o UNDEFINED (HTTP 400), cai para PIX — o
 *    comportamento atual — em vez de deixar a cobrança de renovar de fora;
 *  * PIX | CREDIT_CARD | BOLETO — forma fixada na criação, a pedido do
 *    operador. Cartão SEM dados de cartão aqui: o pagador paga na fatura
 *    hospedada pelo Asaas.
 *
 * Idempotência (não duplicar cobrança em retentativa/duplo clique):
 *  1. cobrança pendente e ainda válida do MESMO período já registrada ->
 *     devolve a existente sem tocar no Asaas;
 *  2. criação anterior que falhou DEPOIS de o Asaas gravar (timeout) ->
 *     a externalReference `subscription:<id>:<periodo>` localiza a cobrança
 *    remota pendente e o registro local é completado.
 *
 * Sem Asaas configurado, devolve { ok:false, motivo:"asaas_nao_configurado" }.
 */
export async function gerarCobrancaPeriodo(
  companyId: number,
  opts: { vencimento?: string; meio?: MeioCobranca } = {},
): Promise<
  | {
      ok: true;
      paymentId: string;
      dueDate: string;
      invoiceUrl: string | null;
      amountCents: number;
      /** Meio efetivamente registrado pelo Asaas (UNDEFINED, PIX, ...). */
      billingType: string;
      /** Só para boleto: PDF e linha digitável (quando o Asaas devolveu). */
      bankSlipUrl: string | null;
      linhaDigitavel: string | null;
      /** true quando não havia nova cobrança a criar (período já cobrado). */
      reutilizada: boolean;
    }
  | { ok: false; motivo: "asaas_nao_configurado" | "sem_empresa" | "sem_dados_bancarios" | "documento_invalido" | "meio_invalido"; erro?: string }
> {
  const meio: MeioCobranca = opts.meio ?? "UNDEFINED";
  if (!ehMeioCobranca(meio)) return { ok: false, motivo: "meio_invalido" };

  const env = asaasTeste ? "sandbox" : await asaasEnvironment();
  if (env === "nao_configurado") return { ok: false, motivo: "asaas_nao_configurado" };

  const empresa = await one<{ id: number; name: string; document: string | null; email: string | null }>(
    `SELECT id, name, document, email FROM companies WHERE id = ? AND active = 1`,
    [companyId],
  );
  if (!empresa) return { ok: false, motivo: "sem_empresa" };

  const sub = await assinaturaDaEmpresa(companyId);
  if (!sub) return { ok: false, motivo: "sem_dados_bancarios" };
  const plano = await one<Plan>(`SELECT * FROM plans WHERE id = ?`, [sub.plan_id]);
  if (!plano) return { ok: false, motivo: "sem_dados_bancarios" };

  const client = asaasTeste
    ? asaasClient(asaasTeste)
    : asaasClient({
        apiKey: (await lerApiKey()) ?? "",
        // ASAAS_ENVIRONMENT=production => api.asaas.com; senão sandbox.
        baseUrl: env === "producao" ? ASAAS_PRODUCAO : ASAAS_SANDBOX,
      });
  if (!asaasTeste && !(await lerApiKey())) return { ok: false, motivo: "asaas_nao_configurado" };

  /**
   * Documento (CPF/CNPJ) da empresa. A tela Configurações grava o CNPJ em
   * company_settings (company_doc) e empresas antigas podem ter só a coluna
   * companies.document — vale a hierarquia entre elas. Nada de placeholder:
   * documento ausente/inválido é recusado aqui, com motivo claro na tela,
   * em vez de explodir dentro do Asaas (causa do erro "CPF/CNPJ inválido").
   */
  const docSettings = await one<{ value: string | null }>(
    `SELECT value FROM company_settings WHERE company_id = ? AND key = 'company_doc'`,
    [companyId],
  );
  const documento =
    (empresa.document ?? "").replace(/\D/g, "") || (docSettings?.value ?? "").replace(/\D/g, "");
  if (!documentoValido(documento)) {
    return { ok: false, motivo: "documento_invalido" };
  }

  const periodo = periodoDaCobranca(sub);
  const { periodStart, periodEnd } = periodo;
  const vencimento = opts.vencimento ?? periodo.vencimento;
  const hoje = hojeISO();

  /**
   * Idempotência local: o MESMO período já tem cobrança pendente ainda
   * válida (vencimento >= hoje) -> devolve ela. Cobre duplo clique e
   * retentativa de tela sem criar segunda cobrança nem tocar no Asaas.
   * Cobrança vencida não trava: o operador pode gerar uma nova.
   */
  const existente = await one<{
    id: number;
    asaas_payment_id: string | null;
    due_date: string | null;
    invoice_url: string | null;
    billing_type: string | null;
    amount_cents: number;
  }>(
    `SELECT id, asaas_payment_id, due_date, invoice_url, billing_type, amount_cents
       FROM subscription_payments
      WHERE company_id = ? AND subscription_id = ?
        AND period_start = ? AND period_end = ?
        AND status = 'pending' AND asaas_payment_id IS NOT NULL
        AND due_date IS NOT NULL AND due_date >= ?
      ORDER BY id DESC LIMIT 1`,
    [companyId, sub.id, periodStart, periodEnd, hoje],
  );
  if (existente?.asaas_payment_id) {
    return {
      ok: true,
      paymentId: existente.asaas_payment_id,
      dueDate: existente.due_date ?? vencimento,
      invoiceUrl: existente.invoice_url,
      amountCents: existente.amount_cents,
      billingType: existente.billing_type ?? "PIX",
      bankSlipUrl: null,
      linhaDigitavel: null,
      reutilizada: true,
    };
  }

  // externalReference única POR PERÍODO: permite localizar no Asaas uma
  // cobrança criada numa tentativa anterior que falhou antes do INSERT local
  // (timeout de resposta) — a retentativa recupera em vez de duplicar.
  const refExterna = `subscription:${sub.id}:${periodStart}`;

  let customerId = sub.asaas_customer_id;
  try {
    if (!customerId) {
      const cliente = await client.ensureCustomer({
        name: empresa.name,
        cpfCnpj: documento,
        email: empresa.email,
        externalReference: `company:${companyId}`,
      });
      customerId = cliente.id;
      await run(`UPDATE subscriptions SET asaas_customer_id = ? WHERE id = ?`, [customerId, sub.id]);
    }

    // Idempotência remota (best-effort): cobrança pendente já existente no
    // Asaas para este período -> só completa o registro local.
    let recuperada: AsaasPayment | null = null;
    try {
      const candidatas = await client.listPaymentsByExternalReference(refExterna);
      recuperada =
        candidatas.find((p) => p.id && p.status === "PENDING" && p.dueDate === vencimento) ?? null;
    } catch {
      // Lookup é otimização de segurança: falha não impede a criação normal.
    }

    let payment: AsaasPayment;
    if (recuperada) {
      payment = recuperada;
      await registrarCobrancaLocal(companyId, sub.id, payment, plano.price_cents, vencimento, periodStart, periodEnd).catch(
        () => {},
      );
    } else {
      try {
        payment = await client.createPayment({
          customer: customerId,
          billingType: meio,
          value: plano.price_cents / 100,
          dueDate: vencimento,
          description: `Assinatura ${plano.name} — ${empresa.name}`,
          externalReference: refExterna,
        });
      } catch (e) {
        // Fallback de estabilidade: se a conta/fluxo recusar a fatura com
        // escolha do pagador (HTTP 400 = nada foi criado), cai para PIX —
        // o comportamento atual — em vez de a cobrança de renovação falhar.
        if (!(e instanceof AsaasError && e.status === 400 && meio === "UNDEFINED")) throw e;
        payment = await client.createPayment({
          customer: customerId,
          billingType: "PIX",
          value: plano.price_cents / 100,
          dueDate: vencimento,
          description: `Assinatura ${plano.name} — ${empresa.name}`,
          externalReference: refExterna,
        });
      }
      await registrarCobrancaLocal(companyId, sub.id, payment, plano.price_cents, vencimento, periodStart, periodEnd);
    }

    // Boleto: linha digitável/código de barras — best-effort (a fatura e o
    // PDF continuam disponíveis mesmo se esta consulta falhar).
    let linhaDigitavel: string | null = null;
    if ((payment.billingType || meio) === "BOLETO" && payment.id) {
      try {
        const linha = await client.getBankSlipLine(payment.id);
        linhaDigitavel = linha.identificationField ?? null;
      } catch {
        linhaDigitavel = null;
      }
    }

    // Aviso ao owner (fail-open): cobrança à disposição com link da fatura.
    const owner = await ownerDaEmpresa(companyId);
    if (owner?.email) {
      void enviarEmail({
        to: owner.email,
        subject: "Cobrança gerada — Locô",
        html: emailCobrancaGerada(
          empresa.name,
          plano.name,
          dinheiroFmt(plano.price_cents),
          vencimento,
          payment.invoiceUrl ?? null,
          payment.billingType || meio,
        ),
      }).catch(() => false);
    }

    return {
      ok: true,
      paymentId: payment.id,
      dueDate: vencimento,
      invoiceUrl: payment.invoiceUrl ?? null,
      amountCents: plano.price_cents,
      billingType: payment.billingType || meio,
      bankSlipUrl: payment.bankSlipUrl ?? null,
      linhaDigitavel,
      reutilizada: false,
    };
  } catch (e) {
    if (e instanceof AsaasError) {
      // Log para o tail do Worker: sem isso a falha fica invisível atrás da
      // mensagem genérica da tela. Nunca loga a API key — só status/erro.
      console.error("[billing] AsaasError ao gerar cobrança:", e.status, e.message, JSON.stringify(e.errors ?? []));
      return { ok: false, motivo: "sem_dados_bancarios", erro: e.message };
    }
    throw e;
  }
}

/**
 * Lê a API key resolvida (secret do Worker > cadastro do painel /saas).
 * Nunca vem do request — só destas duas fontes de servidor.
 */
async function lerApiKey(): Promise<string | null> {
  const { credenciaisAsaas } = await import("./platform-settings");
  return (await credenciaisAsaas()).apiKey;
}

export type DadosPagamento = {
  paymentId: string;
  billingType: string;
  statusAsaas: string;
  invoiceUrl: string | null;
  /** Boleto: PDF. */
  bankSlipUrl: string | null;
  /** Boleto: linha digitável (quando o Asaas devolveu). */
  linhaDigitavel: string | null;
  /** Pix: código copia e cola (quando disponível). */
  pixPayload: string | null;
  /** Pix: QR Code em base64 (quando disponível). */
  pixQrCode: string | null;
};

/**
 * Dados de pagamento de UMA cobrança da empresa — consulta ao Asaas sob
 * demanda (nada sensível é persistido além do que já existe).
 *
 * Isolamento multiempresa garantido aqui: a linha é buscada por id E
 * company_id; cobrança de outra empresa devolve null, sem consultar o Asaas.
 */
export async function dadosPagamentoCobranca(
  companyId: number,
  pagamentoId: number,
): Promise<DadosPagamento | null> {
  const linha = await one<{ id: number; asaas_payment_id: string | null }>(
    `SELECT id, asaas_payment_id FROM subscription_payments WHERE id = ? AND company_id = ?`,
    [pagamentoId, companyId],
  );
  if (!linha?.asaas_payment_id) return null;

  const env = asaasTeste ? "sandbox" : await asaasEnvironment();
  if (env === "nao_configurado") return null;
  const client = asaasTeste
    ? asaasClient(asaasTeste)
    : asaasClient({
        apiKey: (await lerApiKey()) ?? "",
        baseUrl: env === "producao" ? ASAAS_PRODUCAO : ASAAS_SANDBOX,
      });
  if (!asaasTeste && !(await lerApiKey())) return null;

  let payment: AsaasPayment;
  try {
    payment = await client.getPayment(linha.asaas_payment_id);
  } catch (e) {
    if (e instanceof AsaasError) {
      console.error("[billing] AsaasError ao consultar pagamento:", e.status, e.message);
      return null;
    }
    throw e;
  }

  const meio = payment.billingType ?? "";
  let bankSlipUrl: string | null = payment.bankSlipUrl ?? null;
  let linhaDigitavel: string | null = null;
  let pixPayload: string | null = null;
  let pixQrCode: string | null = null;

  // Dados extras por modalidade — best-effort: a fatura continua válida
  // mesmo que uma dessas consultas falhe.
  if (meio === "BOLETO") {
    try {
      linhaDigitavel = (await client.getBankSlipLine(payment.id)).identificationField ?? null;
    } catch {
      linhaDigitavel = null;
    }
  } else if (meio === "PIX") {
    try {
      const qr = await client.getPixQrCode(payment.id);
      pixPayload = qr.payload ?? null;
      pixQrCode = qr.encodedImage ?? null;
    } catch {
      pixPayload = null;
      pixQrCode = null;
    }
  }

  return {
    paymentId: payment.id,
    billingType: meio,
    statusAsaas: payment.status,
    invoiceUrl: payment.invoiceUrl ?? null,
    bankSlipUrl,
    linhaDigitavel,
    pixPayload,
    pixQrCode,
  };
}

/* ------------------------------------------------------------------ */
/* Webhook — processamento idempotente de eventos do Asaas              */
/* ------------------------------------------------------------------ */

/**
 * Aplica um evento PAYMENT_* já gravado em webhook_events.
 *
 * Idempotente: chamado só para hashes novos (o route garante). Mapeia o
 * status do Asaas para o nosso e, ao confirmar recebimento, ativa/renova a
 * assinatura com o período coberto.
 */
export async function processarEventoPayment(event: string, payload: any): Promise<void> {
  const payment = payload?.payment ?? {};
  const asaasId = typeof payment.id === "string" ? payment.id : null;
  if (!asaasId) return;

  const linha = await one<{
    id: number;
    company_id: number;
    subscription_id: number;
    amount_cents: number;
    status: string;
  }>(
    `SELECT id, company_id, subscription_id, amount_cents, status FROM subscription_payments WHERE asaas_payment_id = ?`,
    [asaasId],
  );
  // Pagamento desconhecido (criado fora do sistema): registra e sai.
  if (!linha) {
    await run(`UPDATE webhook_events SET handled = 1, handled_at = datetime('now','localtime'),
                 error = 'payment sem correspondencia local' WHERE event = ? AND payload_hash IN
                 (SELECT payload_hash FROM webhook_events WHERE handled = 0 AND event = ?)`, [event, event]).catch(() => {});
    return;
  }

  const status = normalizarStatus(event, payment.status);

  // Evento sem status definitivo (PAYMENT_CREATED, análises de risco de cartão,
  // tipos novos do Asaas…) NÃO pode rebaixar uma cobrança já confirmada para
  // 'pending' — pagamento confirmado só sai daqui por evento explícito
  // (REFUNDED/CANCELED/OVERDUE).
  const statusFinal =
    status === "pending" && ["received", "confirmed", "refunded", "canceled"].includes(linha.status)
      ? linha.status
      : status;

  const paidAt =
    statusFinal === "received" || statusFinal === "confirmed"
      ? linha.status === "received" || linha.status === "confirmed"
        ? null // já confirmada antes: preserva o paid_at original
        : new Date().toISOString().slice(0, 19).replace("T", " ")
      : null;
  // Meio escolhido na fatura (cobrança UNDEFINED) — só grava tipos que o
  // CHECK de subscriptions.payment_method aceita; mantém o atual caso contrário.
  const meioConfirmado = ["PIX", "CREDIT_CARD", "BOLETO"].includes(String(payment.billingType ?? ""))
    ? String(payment.billingType)
    : null;

  await run(
    `UPDATE subscription_payments SET status = ?, paid_at = COALESCE(?, paid_at),
       billing_type = COALESCE(?, billing_type),
       invoice_url = COALESCE(?, invoice_url), invoice_number = COALESCE(?, invoice_number),
       updated_at = datetime('now','localtime')
      WHERE id = ?`,
    [statusFinal, paidAt, meioConfirmado, payment.invoiceUrl ?? null, payment.invoiceNumber ?? null, linha.id],
  );

  if (statusFinal === "received" || statusFinal === "confirmed") {
    await ativarAssinatura(linha.company_id, linha.subscription_id, linha.amount_cents, meioConfirmado ?? undefined);
  }
}

function normalizarStatus(event: string, statusAsaas?: string): string {
  if (event === "PAYMENT_RECEIVED" || event === "PAYMENT_CONFIRMED") return "received";
  if (event === "PAYMENT_REFUNDED") return "refunded";
  if (event === "PAYMENT_DELETED" || event === "PAYMENT_CANCELED") return "canceled";
  if (event === "PAYMENT_OVERDUE") return "overdue";
  switch ((statusAsaas ?? "").toUpperCase()) {
    case "RECEIVED":
    case "CONFIRMED":
      return "received";
    case "OVERDUE":
      return "overdue";
    case "REFUNDED":
      return "refunded";
    case "CANCELED":
    case "DELETED":
      return "canceled";
    default:
      return "pending";
  }
}

/** Recebimento confirmado: assinatura ativa e período renovado (+30 dias). */
async function ativarAssinatura(companyId: number, subscriptionId: number, amountCents: number, billingType?: string) {
  const hoje = hojeISO();
  const atual = await one<{ current_period_end: string | null }>(
    `SELECT current_period_end FROM subscriptions WHERE id = ?`,
    [subscriptionId],
  );
  const base = atual?.current_period_end && meioDiaUTC(atual.current_period_end) > meioDiaUTC(hoje)
    ? atual.current_period_end
    : hoje;
  const novoFim = diaISO(30, base);
  const novoInicio = base;
  await run(
    `UPDATE subscriptions SET status = 'active',
       current_period_start = ?, current_period_end = ?,
       payment_method = COALESCE(?, payment_method),
       suspended_at = NULL, updated_at = datetime('now','localtime')
      WHERE id = ? AND company_id = ?`,
    [novoInicio, novoFim, billingType ?? null, subscriptionId, companyId],
  );

  // Aviso de pagamento confirmado (fail-open): acalma o "paguei, chegou?".
  const empresa = await one<{ name: string }>(`SELECT name FROM companies WHERE id = ?`, [companyId]);
  const plano = await one<{ name: string }>(
    `SELECT p.name FROM subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.id = ?`,
    [subscriptionId],
  );
  const owner = await ownerDaEmpresa(companyId);
  if (empresa && plano && owner?.email) {
    void enviarEmail({
      to: owner.email,
      subject: "Pagamento confirmado — Locô",
      html: emailPagamentoConfirmado(empresa.name, plano.name, dinheiroFmt(amountCents), novoFim),
    }).catch(() => false);
  }
}

/** Owner da empresa: destinatário dos avisos comerciais (1º owner ativo). */
export async function ownerDaEmpresa(companyId: number) {
  return await one<{ id: number; name: string; email: string | null }>(
    `SELECT id, name, email FROM users WHERE company_id = ? AND role = 'owner' AND active = 1 ORDER BY id LIMIT 1`,
    [companyId],
  );
}

/**
 * Aviso de trial ao owner, com deduplicação em billing_alerts (o rebuild da
 * notifications APAGA chaves fora do conjunto dela, então não serve de
 * memória). Chave única por tipo/janela: reenvio idempotente.
 * Devolve true só quando um e-mail novo foi realmente enviado.
 */
async function avisarTrial(
  companyId: number,
  tipo: "expirando" | "expirado",
  fimTrial: string | null,
  urlPublica: string,
): Promise<boolean> {
  const sub = await one<{ id: number; trial_ends_at: string | null }>(
    `SELECT id, trial_ends_at FROM subscriptions WHERE company_id = ?`,
    [companyId],
  );
  if (!sub) return false;
  const chave = `trial-${tipo}:${sub.id}:${fimTrial ?? sub.trial_ends_at ?? ""}`;
  const ja = await one<{ id: number }>(`SELECT id FROM billing_alerts WHERE chave = ?`, [chave]);
  if (ja) return false;

  const empresa = await one<{ name: string }>(`SELECT name FROM companies WHERE id = ?`, [companyId]);
  const owner = await ownerDaEmpresa(companyId);
  if (!empresa || !owner?.email) {
    // Sem destinatário: marca assim mesmo para não martelar a cada minuto.
    await run(`INSERT INTO billing_alerts (company_id, chave) VALUES (?,?)`, [companyId, chave]).catch(() => {});
    return false;
  }

  const html =
    tipo === "expirando"
      ? emailTrialExpirando(empresa.name, fimTrial ?? sub.trial_ends_at ?? "", urlPublica)
      : emailTrialExpirado(empresa.name, urlPublica);
  const ok = await enviarEmail({
    to: owner.email,
    subject:
      tipo === "expirando"
        ? "Seu teste termina em breve — Locô"
        : "Teste encerrado — reative seu acesso — Locô",
    html,
  }).catch(() => false);

  // Marca enviados E falhas: e-mail é best-effort; não reenfileira a cada minuto.
  await run(`INSERT INTO billing_alerts (company_id, chave) VALUES (?,?)`, [companyId, chave]).catch(() => {});
  return ok;
}

/* ------------------------------------------------------------------ */
/* Rotina diária: vencimento de trial, período e inadimplência          */
/* ------------------------------------------------------------------ */

export type RotinaDiariaResultado = {
  trialsExpirados: number;
  periodosVencidos: number;
  marcadasPastDue: number;
  suspensas: number;
  cobrancasGeradas: number;
  avisosTrialEnviados: number;
};

/**
 * Roda uma vez por dia (cron) para TODAS as empresas:
 *  1. trial vencido e sem pagamento -> suspended;
 *  2. período ativo que venceu -> past_due e tenta gerar a próxima cobrança;
 *  3. past_due com cobrança vencida há mais de 7 dias -> suspended.
 *
 * Etapa 5: também avisa o owner por e-mail quando o trial está acabando
 * (3 dias antes) e quando expira — deduplicado por dia na notifications.
 */
export async function rotinaDiariaBilling(): Promise<RotinaDiariaResultado> {
  const hoje = hojeISO();
  const r: RotinaDiariaResultado = {
    trialsExpirados: 0,
    periodosVencidos: 0,
    marcadasPastDue: 0,
    suspensas: 0,
    cobrancasGeradas: 0,
    avisosTrialEnviados: 0,
  };

  const urlPublica = await publicUrlDaPlataforma();

  // 1) Trials expirados
  const trials = await all<{ id: number; company_id: number }>(
    `SELECT id, company_id FROM subscriptions WHERE status = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at < ?`,
    [hoje],
  );
  for (const t of trials) {
    const pagou = await scalar<number>(
      `SELECT COUNT(*) FROM subscription_payments WHERE subscription_id = ? AND status IN ('received','confirmed')`,
      [t.id],
    );
    if (pagou === 0) {
      await run(
        `UPDATE subscriptions SET status = 'suspended', suspended_at = datetime('now','localtime'),
           updated_at = datetime('now','localtime') WHERE id = ?`,
        [t.id],
      );
      r.trialsExpirados++;
      const avisou = await avisarTrial(t.company_id, "expirado", null, urlPublica);
      if (avisou) r.avisosTrialEnviados++;
    }
  }

  // 1b) Trials acabando (3 dias ou menos): aviso único por trial/dia.
  const fimAviso = diaISO(3);
  const acabando = await all<{ id: number; company_id: number; trial_ends_at: string }>(
    `SELECT id, company_id, trial_ends_at FROM subscriptions
      WHERE status = 'trial' AND trial_ends_at IS NOT NULL AND trial_ends_at >= ? AND trial_ends_at <= ?`,
    [hoje, fimAviso],
  );
  for (const t of acabando) {
    const avisou = await avisarTrial(t.company_id, "expirando", t.trial_ends_at, urlPublica);
    if (avisou) r.avisosTrialEnviados++;
  }

  // 2) Períodos ativos vencidos: marca past_due e tenta cobrar o próximo ciclo
  const vencidos = await all<{ id: number; company_id: number }>(
    `SELECT id, company_id FROM subscriptions WHERE status = 'active' AND current_period_end IS NOT NULL AND current_period_end < ?`,
    [hoje],
  );
  for (const v of vencidos) {
    await run(`UPDATE subscriptions SET status = 'past_due', updated_at = datetime('now','localtime') WHERE id = ?`, [v.id]);
    r.periodosVencidos++;
    r.marcadasPastDue++;
    const gerou = await gerarCobrancaPeriodo(v.company_id);
    if (gerou.ok) r.cobrancasGeradas++;
  }

  // 3) past_due antigo: suspende
  const limite = diaISO(-LIMITE_TOLERANCIA_DIAS, hoje);
  const atrasadas = await all<{ id: number }>(
    `SELECT s.id FROM subscriptions s
      WHERE s.status = 'past_due'
        AND EXISTS (SELECT 1 FROM subscription_payments p
                     WHERE p.subscription_id = s.id AND p.status IN ('pending','overdue')
                       AND p.due_date IS NOT NULL AND p.due_date < ?)`,
    [limite],
  );
  for (const a of atrasadas) {
    await run(
      `UPDATE subscriptions SET status = 'suspended', suspended_at = datetime('now','localtime'),
         updated_at = datetime('now','localtime') WHERE id = ?`,
      [a.id],
    );
    r.suspensas++;
  }

  return r;
}

/* ------------------------------------------------------------------ */
/* Painel administrativo (platform admin)                               */
/* ------------------------------------------------------------------ */

export type EmpresaPainel = {
  company_id: number;
  name: string;
  active: number;
  usuarios: number;
  status: SubscriptionStatus | null;
  plano: string | null;
  price_cents: number | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  owner_email: string | null;
};

export async function listarEmpresasPainel(): Promise<EmpresaPainel[]> {
  return await all<EmpresaPainel>(
    `SELECT c.id AS company_id, c.name, c.active,
            (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1) AS usuarios,
            (SELECT u2.email FROM users u2 WHERE u2.company_id = c.id AND u2.role = 'owner' AND u2.active = 1
              ORDER BY u2.id LIMIT 1) AS owner_email,
            s.status, p.name AS plano, p.price_cents, s.current_period_end, s.trial_ends_at
       FROM companies c
       LEFT JOIN subscriptions s ON s.company_id = c.id
       LEFT JOIN plans p ON p.id = s.plan_id
      ORDER BY c.id`,
  );
}

/** Métricas resumidas para o cabeçalho do painel. */
export async function metricasPainel() {
  const mrr = await scalar<number>(
    `SELECT COALESCE(SUM(p.price_cents),0) FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
      WHERE s.status IN ('active','past_due')`,
  );
  const ativas = await scalar<number>(`SELECT COUNT(*) FROM subscriptions WHERE status IN ('active','past_due')`);
  const trials = await scalar<number>(`SELECT COUNT(*) FROM subscriptions WHERE status = 'trial'`);
  const suspensas = await scalar<number>(`SELECT COUNT(*) FROM subscriptions WHERE status IN ('suspended','canceled')`);
  const empresas = await scalar<number>(`SELECT COUNT(*) FROM companies WHERE active = 1`);
  return { mrr, ativas, trials, suspensas, empresas };
}

/** Ações da plataforma sobre uma assinatura (só platform admin). */
export async function acaoPlataforma(
  companyId: number,
  acao: "suspender" | "reativar" | "cancelar" | "reativar_trial",
): Promise<void> {
  const sub = await assinaturaDaEmpresa(companyId);
  if (!sub) throw new Error("Empresa sem assinatura.");
  if (acao === "suspender") {
    await run(
      `UPDATE subscriptions SET status = 'suspended', suspended_at = datetime('now','localtime'),
         updated_at = datetime('now','localtime') WHERE id = ?`,
      [sub.id],
    );
  } else if (acao === "reativar") {
    const fim = sub.current_period_end ?? proximoVencimento();
    await run(
      `UPDATE subscriptions SET status = 'active', suspended_at = NULL, canceled_at = NULL,
         current_period_end = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
      [fim, sub.id],
    );
  } else if (acao === "cancelar") {
    await run(
      `UPDATE subscriptions SET status = 'canceled', canceled_at = datetime('now','localtime'),
         updated_at = datetime('now','localtime') WHERE id = ?`,
      [sub.id],
    );
  } else {
    const dias = await scalar<number>(`SELECT trial_days FROM plans WHERE id = ?`, [sub.plan_id]);
    await run(
      `UPDATE subscriptions SET status = 'trial', trial_ends_at = ?, suspended_at = NULL, canceled_at = NULL,
         updated_at = datetime('now','localtime') WHERE id = ?`,
      [diaISO(dias || 14), sub.id],
    );
  }
}

/* ------------------------------------------------------------------ */
/* Financeiro da plataforma (painel /saas)                              */
/* ------------------------------------------------------------------ */

/** Uma cobrança do painel, já enriquecida com empresa e plano. */
export type CobrancaPainel = {
  id: number;
  company_id: number;
  empresa: string;
  plano: string | null;
  asaas_payment_id: string | null;
  amount_cents: number;
  status: string;
  due_date: string | null;
  paid_at: string | null;
  period_start: string | null;
  period_end: string | null;
  invoice_url: string | null;
};

/**
 * Cobranças da plataforma com nome da empresa e plano. Ordem: as mais
 * relevantes primeiro (vencidas, a vencer) e depois as pagas antigas.
 */
export async function listarCobrancasPainel(limite = 200): Promise<CobrancaPainel[]> {
  return await all<CobrancaPainel>(
    `SELECT sp.id, sp.company_id, c.name AS empresa, p.name AS plano,
            sp.asaas_payment_id, sp.amount_cents, sp.status, sp.due_date,
            sp.paid_at, sp.period_start, sp.period_end, sp.invoice_url
       FROM subscription_payments sp
       JOIN companies c ON c.id = sp.company_id
       LEFT JOIN subscriptions s ON s.id = sp.subscription_id
       LEFT JOIN plans p ON p.id = s.plan_id
      ORDER BY CASE sp.status WHEN 'pending' THEN 0 WHEN 'overdue' THEN 0 ELSE 1 END,
               COALESCE(sp.due_date, '9999-12-31') DESC, sp.id DESC
      LIMIT ?`,
    [limite],
  );
}

/** Números do mês corrente (fuso de Brasília) para os cards do painel. */
export async function resumoFinanceiroPainel() {
  const hoje = hojeISO();
  const primeiroDia = `${hoje.slice(0, 7)}-01`;

  // "No mês" = pago neste mês de acordo com paid_at (data do crédito).
  const recebido = await scalar<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM subscription_payments
      WHERE status IN ('received','confirmed') AND paid_at >= ?`,
    [primeiroDia],
  );
  const pixPendentes = await scalar<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM subscription_payments WHERE status = 'pending'`,
  );
  const pixPendentesQtd = await scalar<number>(
    `SELECT COUNT(*) FROM subscription_payments WHERE status = 'pending'`,
  );
  // Inadimplência: cobrança vencida e não paga.
  const inadimplencia = await scalar<number>(
    `SELECT COALESCE(SUM(amount_cents),0) FROM subscription_payments
      WHERE status IN ('pending','overdue') AND due_date IS NOT NULL AND due_date < ?`,
    [hoje],
  );
  const inadimplentesQtd = await scalar<number>(
    `SELECT COUNT(DISTINCT company_id) FROM subscription_payments
      WHERE status IN ('pending','overdue') AND due_date IS NOT NULL AND due_date < ?`,
    [hoje],
  );

  return { recebido, pixPendentes, pixPendentesQtd, inadimplencia, inadimplentesQtd, primeiroDia };
}

/** Um evento do webhook do Asaas (auditoria). */
export type EventoWebhookPainel = {
  id: number;
  event: string;
  handled: number;
  error: string | null;
  created_at: string;
};

/** Últimos eventos recebidos do Asaas — trilha de auditoria do painel. */
export async function listarEventosWebhookPainel(limite = 20): Promise<EventoWebhookPainel[]> {
  return await all<EventoWebhookPainel>(
    `SELECT id, event, handled, error, created_at
       FROM webhook_events ORDER BY id DESC LIMIT ?`,
    [limite],
  );
}

/* ------------------------------------------------------------------ */
/* Alertas do painel SaaS (dashboard administrativo)                    */
/* ------------------------------------------------------------------ */

export type AlertaSaas = {
  severidade: "critico" | "aviso" | "info";
  titulo: string;
  detalhe: string;
  href: string;
};

/**
 * Alertas consolidados da PLATAFORMA (não da empresa): trial acabando,
 * cobranças vencidas, períodos vencendo, assinaturas suspensas, eventos de
 * webhook com falha. Só descreve fatos já persistidos — nada inventado.
 */
export async function alertasSaasPainel(): Promise<AlertaSaas[]> {
  const hoje = hojeISO();
  const alertas: AlertaSaas[] = [];

  const acabando = await all<{ name: string; trial_ends_at: string }>(
    `SELECT c.name, s.trial_ends_at FROM subscriptions s
       JOIN companies c ON c.id = s.company_id
      WHERE s.status = 'trial' AND s.trial_ends_at IS NOT NULL
        AND s.trial_ends_at >= ? AND s.trial_ends_at <= ?
      ORDER BY s.trial_ends_at`,
    [hoje, diaISO(7)],
  );
  for (const a of acabando) {
    alertas.push({
      severidade: "aviso",
      titulo: `Trial acabando: ${a.name}`,
      detalhe: `Período de teste termina em ${dataBRz(a.trial_ends_at)} — contato para converter.`,
      href: "/saas/assinaturas",
    });
  }

  const vencidas = await all<{ empresa: string; due_date: string; amount_cents: number }>(
    `SELECT c.name AS empresa, sp.due_date, sp.amount_cents FROM subscription_payments sp
       JOIN companies c ON c.id = sp.company_id
      WHERE sp.status IN ('pending','overdue') AND sp.due_date IS NOT NULL AND sp.due_date < ?
      ORDER BY sp.due_date`,
    [hoje],
  );
  for (const v of vencidas) {
    alertas.push({
      severidade: "critico",
      titulo: `Cobrança vencida: ${v.empresa}`,
      detalhe: `${dinheiroFmt(v.amount_cents)} venceram em ${dataBRz(v.due_date)}.`,
      href: "/saas/cobrancas",
    });
  }

  const vencendo = await all<{ name: string; current_period_end: string }>(
    `SELECT c.name, s.current_period_end FROM subscriptions s
       JOIN companies c ON c.id = s.company_id
      WHERE s.status = 'active' AND s.current_period_end IS NOT NULL
        AND s.current_period_end >= ? AND s.current_period_end <= ?
      ORDER BY s.current_period_end`,
    [hoje, diaISO(7)],
  );
  for (const p of vencendo) {
    alertas.push({
      severidade: "info",
      titulo: `Período vence em breve: ${p.name}`,
      detalhe: `Renovação em ${dataBRz(p.current_period_end)} — a rotina diária gera a cobrança.`,
      href: "/saas/assinaturas",
    });
  }

  // Divergência entre plano gravado e o que foi efetivamente cobrado
  // (correção de planos): cobrança confirmada por valor diferente do preço do
  // plano VIGENTE, gerada depois da última troca de plano. Só SINALIZA no
  // painel — a correção é humana, pela ação "Plano" de cada empresa.
  const divergentes = await all<
    { name: string; nome_plano: string; amount_cents: number; price_cents: number }
  >(
    `SELECT c.name, p.name AS nome_plano, sp.amount_cents, p.price_cents
       FROM subscription_payments sp
       JOIN subscriptions s ON s.id = sp.subscription_id
       JOIN companies c ON c.id = s.company_id
       JOIN plans p ON p.id = s.plan_id
      WHERE sp.status IN ('received','confirmed')
        AND sp.amount_cents <> p.price_cents
        AND sp.created_at >= s.updated_at
      ORDER BY sp.created_at DESC
      LIMIT 10`,
  );
  for (const d of divergentes) {
    alertas.push({
      severidade: "aviso",
      titulo: `Plano x cobrança divergentes: ${d.name}`,
      detalhe: `Plano gravado ${d.nome_plano} (${dinheiroFmt(d.price_cents)}) mas a cobrança confirmada mais recente foi ${dinheiroFmt(d.amount_cents)}. Revisar o plano da empresa.`,
      href: "/saas/assinaturas",
    });
  }

  const suspensas = await scalar<number>(
    `SELECT COUNT(*) FROM subscriptions WHERE status IN ('suspended','canceled')`,
  );
  if (suspensas > 0) {
    alertas.push({
      severidade: "aviso",
      titulo: `${suspensas} assinatura${suspensas === 1 ? "" : "s"} bloqueada${suspensas === 1 ? "" : "s"}`,
      detalhe: "Suspensas por inadimplência ou canceladas — reativar na tela de assinaturas.",
      href: "/saas/assinaturas",
    });
  }

  const falhas = await scalar<number>(
    `SELECT COUNT(*) FROM webhook_events WHERE handled = 0`,
  );
  if (falhas > 0) {
    alertas.push({
      severidade: "critico",
      titulo: `${falhas} evento${falhas === 1 ? "" : "s"} do Asaas sem processar`,
      detalhe: "Verificar a trilha de eventos — pode haver pagamento confirmado não aplicado.",
      href: "/saas/eventos",
    });
  }

  return alertas;
}

function dataBRz(iso: string | null): string {
  return iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—";
}

/** Atividade administrativa recente (audit_logs globais da plataforma). */
export async function atividadeRecentePainel(limite = 12) {
  return await all<{
    id: number;
    user_name: string | null;
    action: string;
    entity: string;
    entity_id: number | null;
    summary: string;
    created_at: string;
  }>(
    `SELECT id, user_name, action, entity, entity_id, summary, created_at
       FROM audit_logs ORDER BY id DESC LIMIT ?`,
    [limite],
  );
}
