/**
 * E-mail transacional via Resend (Etapa 5).
 *
 * Escolha do Resend (HTTPS simples) em vez do SendEmail nativo do Cloudflare:
 * o Worker do projeto já fala HTTPS com provedores externos (Asaas) e o
 * SendEmail exige domínio verificado + binding específico por ambiente. Com o
 * Resend a troca é um secret (RESEND_API_KEY) e o remetente é um domínio
 * verificado na conta (RESEND_FROM).
 *
 * Regras:
 *  * FAIL-OPEN: falha de envio NUNCA derruba a operação (cadastro, cron,
 *    redefinição de senha já aplicada). O e-mail é consequência, não etapa.
 *  * Sem RESEND_API_KEY configurado, tudo funciona e apenas NÃO envia —
 *    mesmo contrato do Asaas (billing segue sem integração).
 *  * Sem next/*: o cron do Worker importa billing.ts, que importa este
 *    módulo. Config lida via getCloudflareContext sob demanda.
 *  * Gancho de teste __definirEmailTeste (mesmo padrão do billing/Asaas).
 */

export type EmailMensagem = {
  to: string;
  subject: string;
  html: string;
  /** Texto simples como fallback de clientes sem HTML. */
  text?: string;
};

export type EmailConfig = {
  apiKey: string;
  from: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

let emailTeste: EmailConfig | null = null;

/** Gancho de teste: define a config usada por enviarEmail sem tocar em secrets. */
export function __definirEmailTeste(cfg: EmailConfig | null) {
  emailTeste = cfg;
}

/** Enviados registrados pela config de teste (o teste inspeciona em memória). */
export const __emailsEnviados: EmailMensagem[] = [];

async function lerConfig(): Promise<EmailConfig | null> {
  if (emailTeste) return emailTeste;
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = getCloudflareContext().env;
    if (!env.RESEND_API_KEY) return null;
    return {
      apiKey: env.RESEND_API_KEY,
      from: env.RESEND_FROM || "Lima's Locações <onboarding@resend.dev>",
    };
  } catch {
    return null; // fora de request (teste/cron sem contexto): sem envio
  }
}

export async function emailConfigurado(): Promise<boolean> {
  return (await lerConfig()) !== null;
}

/**
 * URL pública da plataforma para links em e-mails gerados FORA de request
 * (cron da rotina de billing). Vem da var PUBLIC_URL por ambiente — em
 * request, prefira montar a origem a partir dos headers (links sempre no
 * domínio que o usuário acessou).
 */
export async function publicUrlDaPlataforma(): Promise<string> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    return getCloudflareContext().env.PUBLIC_URL || "";
  } catch {
    return "";
  }
}

/**
 * Envia um e-mail. Nunca lança: devolve true/false para o chamador decidir
 * se registra algo — a operação que motivou o envio segue em qualquer caso.
 */
export async function enviarEmail(msg: EmailMensagem): Promise<boolean> {
  const cfg = await lerConfig();
  if (!cfg) return false;
  if (emailTeste) __emailsEnviados.push(msg);

  try {
    const res = await (cfg.fetchImpl ?? fetch)(`${cfg.baseUrl ?? "https://api.resend.com"}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: cfg.from,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });
    if (!res.ok) {
      /*
       * Fail-open NÃO é fail-silent: a falha fica registrada no diário de
       * erros (e no tail do Worker) para o suporte diagnosticar — o caso real
       * que isso resolve é o remetente com domínio não verificado, que o
       * Resend recusa com 403 e ninguém percebia (tela de sucesso, e-mail
       * que nunca chega).
       */
      const corpo = await res.text().catch(() => "");
      console.error(
        `[email] falha no envio (${res.status}) para ${msg.to} — assunto: "${msg.subject}" — resposta: ${corpo.slice(0, 300)}`,
      );
      try {
        const { registrarErro } = await import("./error-log");
        await registrarErro({
          source: "api/email",
          kind: "server",
          message: `Falha ao enviar e-mail (${res.status}): ${corpo.slice(0, 200)}`,
          context: { to: msg.to, subject: msg.subject, from: cfg.from },
        });
      } catch {
        // diagnóstico nunca compete com o fluxo original
      }
    }
    return res.ok;
  } catch (e) {
    console.error("[email] falha de rede ao enviar para", msg.to, ":", (e as Error)?.message ?? e);
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Templates                                                           */
/* ------------------------------------------------------------------ */

/**
 * Layout único: tabela de e-mail (client de e-mail não entende flexbox).
 * Estilo sóbrio, botão em cor sólida com fallback de texto.
 */
function layout(titulo: string, corpo: string, botao?: { href: string; label: string }): string {
  return `<!doctype html>
<html lang="pt-BR">
  <body style="margin:0;padding:0;background:#F5F7FF;font-family:Segoe UI,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7FF;padding:24px 12px;">
      <tr><td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #D7DEF2;border-radius:16px;">
          <tr><td style="padding:20px 24px;border-bottom:1px solid #E8ECFA;">
            <span style="display:inline-block;background:#051094;color:#ffffff;font-weight:800;font-size:16px;border-radius:10px;padding:6px 10px;">L</span>
            <span style="font-weight:800;color:#1A1816;margin-left:8px;">Lima's Locações</span>
          </td></tr>
          <tr><td style="padding:24px;">
            <h1 style="margin:0 0 12px;font-size:18px;color:#1A1816;">${titulo}</h1>
            <div style="font-size:14px;line-height:1.6;color:#4A4A52;">${corpo}</div>
            ${
              botao
                ? `<p style="margin:20px 0 4px;"><a href="${botao.href}" style="display:inline-block;background:#051094;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;border-radius:12px;padding:12px 20px;">${botao.label}</a></p>`
                : ""
            }
          </td></tr>
          <tr><td style="padding:16px 24px;border-top:1px solid #E8ECFA;font-size:12px;color:#6B7280;">
            Enviado pelo sistema Lima's Locações. Se você não esperava este e-mail, ignore.
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

function dataBR(iso: string | null): string {
  return iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—";
}

/** Boas-vindas do primeiro acesso (/setup) — instalação nova, sem trial. */
export function emailBoasVindasSetup(nome: string, empresa: string, baseUrl: string): EmailMensagem["html"] {
  return layout(
    `Bem-vindo(a), ${nome}!`,
    `<p>Sua conta da empresa <b>${empresa}</b> está pronta.</p>
     <p>Entre com o usuário que você criou. Se precisar, a recuperação de senha
     envia o link para <b>este e-mail</b>.</p>`,
    { href: `${baseUrl}/login`, label: "Entrar no sistema" },
  );
}

export function emailBoasVindas(nome: string, empresa: string, trialEndsAt: string, baseUrl: string): EmailMensagem["html"] {
  return layout(
    `Bem-vindo(a), ${nome}!`,
    `<p>Sua conta da empresa <b>${empresa}</b> está pronta.</p>
     <p>Você tem <b>acesso completo até ${dataBR(trialEndsAt)}</b>, sem cartão de crédito.
     Quando quiser contratar, é só abrir <b>Faturamento</b> dentro do sistema.</p>`,
    { href: `${baseUrl}/dashboard`, label: "Abrir o sistema" },
  );
}

export function emailTrialExpirando(empresa: string, trialEndsAt: string, baseUrl: string): string {
  return layout(
    "Seu período de teste está acabando",
    `<p>A avaliação da empresa <b>${empresa}</b> termina em <b>${dataBR(trialEndsAt)}</b>.</p>
     <p>Contrate um plano dentro do sistema para não perder o acesso — seus dados ficam guardados.</p>`,
    { href: `${baseUrl}/faturamento`, label: "Contratar plano" },
  );
}

export function emailTrialExpirado(empresa: string, baseUrl: string): string {
  return layout(
    "Seu acesso está pausado",
    `<p>O período de teste da empresa <b>${empresa}</b> terminou e o acesso está temporariamente bloqueado.</p>
     <p>Nada foi cobrado. Para reativar, contrate um plano — tudo volta exatamente como estava.</p>`,
    { href: `${baseUrl}/faturamento`, label: "Reativar meu acesso" },
  );
}

export function emailCobrancaGerada(empresa: string, plano: string, valorFmt: string, vencimento: string, invoiceUrl: string | null): string {
  return layout(
    "Cobrança gerada",
    `<p>Geramos a cobrança do plano <b>${plano}</b> da empresa <b>${empresa}</b>:</p>
     <p><b>${valorFmt}</b> · vencimento <b>${dataBR(vencimento)}</b></p>
     ${invoiceUrl ? `<p>Abra a fatura para pagar via PIX:</p>` : "<p>O pagamento confirma automaticamente e o acesso renova por 30 dias.</p>"}`,
    invoiceUrl ? { href: invoiceUrl, label: "Pagar com PIX" } : undefined,
  );
}

export function emailPagamentoConfirmado(empresa: string, plano: string, valorFmt: string, novoFim: string): string {
  return layout(
    "Pagamento confirmado",
    `<p>Recebemos <b>${valorFmt}</b> referente ao plano <b>${plano}</b> da empresa <b>${empresa}</b>.</p>
     <p>O acesso está ativo até <b>${dataBR(novoFim)}</b>. Obrigado!</p>`,
  );
}
