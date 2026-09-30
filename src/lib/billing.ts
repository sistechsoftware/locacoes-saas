/**
 * Camada comercial do SaaS (Etapa 3): planos, assinatura, trial, cobrança
 * PIX via Asaas (sandbox/produção por secrets) e inadimplência.
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
import { AsaasError, asaasClient, asaasEnvironment, ASAAS_SANDBOX, ASAAS_PRODUCAO } from "./asaas";
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
  plano: { name: string; price_cents: number; max_users: number } | null;
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
/* Cobrança PIX via Asaas                                               */
/* ------------------------------------------------------------------ */

const LIMITE_TOLERANCIA_DIAS = 7;

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

/**
 * Gera a cobrança PIX do próximo período.
 *
 * Fluxo: garante assinatura -> garante cliente no Asaas (empresa 1 usa os
 * dados cadastrados; demais, o nome da empresa) -> cria o payment PIX ->
 * registra em subscription_payments com o período coberto.
 *
 * Sem Asaas configurado, devolve { ok:false, motivo:"asaas_nao_configurado" }.
 */
export async function gerarCobrancaPeriodo(
  companyId: number,
  opts: { vencimento?: string } = {},
): Promise<
  | { ok: true; paymentId: string; dueDate: string; invoiceUrl: string | null; amountCents: number }
  | { ok: false; motivo: "asaas_nao_configurado" | "sem_empresa" | "sem_dados_bancarios"; erro?: string }
> {
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

  const documento = (empresa.document ?? "").replace(/\D/g, "");
  const client = asaasTeste
    ? asaasClient(asaasTeste)
    : asaasClient({
        apiKey: (await lerApiKey()) ?? "",
        // ASAAS_ENVIRONMENT=production => api.asaas.com; senão sandbox.
        baseUrl: env === "producao" ? ASAAS_PRODUCAO : ASAAS_SANDBOX,
      });
  if (!asaasTeste && !(await lerApiKey())) return { ok: false, motivo: "asaas_nao_configurado" };

  let customerId = sub.asaas_customer_id;
  try {
    if (!customerId) {
      const cliente = await client.ensureCustomer({
        name: empresa.name,
        cpfCnpj: documento || "00000000000",
        email: empresa.email,
        externalReference: `company:${companyId}`,
      });
      customerId = cliente.id;
      await run(`UPDATE subscriptions SET asaas_customer_id = ? WHERE id = ?`, [customerId, sub.id]);
    }

    const vencimento = opts.vencimento ?? proximoVencimento(sub.current_period_end ?? undefined);
    const periodStart = sub.current_period_end ?? diaISO(0);
    const periodEnd = diaISO(30, periodStart);
    const payment = await client.createPixPayment({
      customer: customerId,
      value: plano.price_cents / 100,
      dueDate: vencimento,
      description: `Assinatura ${plano.name} — ${empresa.name}`,
      externalReference: `subscription:${sub.id}`,
    });

    await insert(
      `INSERT INTO subscription_payments
         (company_id, subscription_id, asaas_payment_id, amount_cents, billing_type, status, due_date, period_start, period_end, invoice_url)
       VALUES (?,?,?,?,?,'pending',?,?,?,?)`,
    [companyId, sub.id, payment.id, plano.price_cents, payment.billingType || "PIX", vencimento, periodStart, periodEnd, payment.invoiceUrl ?? null],
    );

    // Aviso ao owner (fail-open): cobrança à disposição com link da fatura.
    const owner = await ownerDaEmpresa(companyId);
    if (owner?.email) {
      void enviarEmail({
        to: owner.email,
        subject: "Cobrança gerada — Lima's Locações",
        html: emailCobrancaGerada(empresa.name, plano.name, dinheiroFmt(plano.price_cents), vencimento, payment.invoiceUrl ?? null),
      }).catch(() => false);
    }

    return { ok: true, paymentId: payment.id, dueDate: vencimento, invoiceUrl: payment.invoiceUrl ?? null, amountCents: plano.price_cents };
  } catch (e) {
    if (e instanceof AsaasError) {
      // Log para o tail do Worker: sem isso a falha fica invisível atrás da
      // mensagem genérica da tela.
      console.error("[billing] AsaasError ao gerar cobrança:", e.status, e.message, JSON.stringify(e.errors ?? []));
      return { ok: false, motivo: "sem_dados_bancarios", erro: e.message };
    }
    throw e;
  }
}

/** Lê a API key dos secrets do Worker (nunca do request). */
async function lerApiKey(): Promise<string | null> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    return getCloudflareContext().env.ASAAS_API_KEY ?? null;
  } catch {
    return null;
  }
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

  const linha = await one<{ id: number; company_id: number; subscription_id: number; amount_cents: number }>(
    `SELECT id, company_id, subscription_id, amount_cents FROM subscription_payments WHERE asaas_payment_id = ?`,
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
  const paidAt = status === "received" || status === "confirmed" ? new Date().toISOString().slice(0, 19).replace("T", " ") : null;

  await run(
    `UPDATE subscription_payments SET status = ?, paid_at = COALESCE(?, paid_at),
       invoice_url = COALESCE(?, invoice_url), invoice_number = COALESCE(?, invoice_number),
       updated_at = datetime('now','localtime')
      WHERE id = ?`,
    [status, paidAt, payment.invoiceUrl ?? null, payment.invoiceNumber ?? null, linha.id],
  );

  if (status === "received" || status === "confirmed") {
    await ativarAssinatura(linha.company_id, linha.subscription_id, linha.amount_cents, payment.billingType);
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
      subject: "Pagamento confirmado — Lima's Locações",
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
        ? "Seu teste termina em breve — Lima's Locações"
        : "Teste encerrado — reative seu acesso — Lima's Locações",
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
};

export async function listarEmpresasPainel(): Promise<EmpresaPainel[]> {
  return await all<EmpresaPainel>(
    `SELECT c.id AS company_id, c.name, c.active,
            (SELECT COUNT(*) FROM users u WHERE u.company_id = c.id AND u.active = 1) AS usuarios,
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
