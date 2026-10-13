import "server-only";

/**
 * Cliente minimalista da API v3 do Asaas.
 *
 * Foco da Etapa 3: clientes, cobranças PIX e conciliação de status. O
 * ambiente (sandbox/produção) vem de secrets por Worker — nunca de parâmetro
 * do cliente. O `fetch` é injetável para os testes exercitarem o mapeamento
 * de erros e as chamadas sem rede.
 */

export type AsaasConfig = {
  apiKey: string;
  /** "https://api-sandbox.asaas.com" (padrão) ou "https://api.asaas.com". */
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

export class AsaasError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errors: { code: string; description: string }[] = [],
  ) {
    super(message);
    this.name = "AsaasError";
  }
}

export type AsaasCustomer = {
  id: string;
  name: string;
  cpfCnpj: string;
  email?: string | null;
};

export type AsaasPayment = {
  id: string;
  status: string;
  value: number;
  billingType: string;
  dueDate: string;
  externalReference?: string | null;
  invoiceUrl?: string | null;
  /** Boleto em PDF (só para cobranças BOLETO). */
  bankSlipUrl?: string | null;
  invoiceNumber?: string | null;
};

/**
 * Meios de pagamento aceitos pelo POST /v3/payments (API v3 do Asaas).
 *
 *  * UNDEFINED — a fatura do Asaas deixa o PAGADOR escolher entre os meios
 *    habilitados na conta (Pix, cartão, boleto). Não é "vários billingType na
 *    mesma cobrança": é uma cobrança cuja forma é decidida na fatura.
 *  * PIX | BOLETO | CREDIT_CARD — forma fixada na criação (Alternativa A).
 *
 * Cartão sem dados do cartão aqui: o pagador informa o cartão na fatura
 * hospedada pelo Asaas — o Locô nunca vê número, bandeira ou CVV.
 */
export const MEIOS_COBRANCA = ["UNDEFINED", "PIX", "BOLETO", "CREDIT_CARD"] as const;
export type MeioCobranca = (typeof MEIOS_COBRANCA)[number];

export function ehMeioCobranca(valor: unknown): valor is MeioCobranca {
  return typeof valor === "string" && (MEIOS_COBRANCA as readonly string[]).includes(valor);
}

export const ASAAS_SANDBOX = "https://api-sandbox.asaas.com";
export const ASAAS_PRODUCAO = "https://api.asaas.com";

type AsaasBody = { errors?: { code: string; description: string }[] } & Record<string, any>;

/**
 * Ambiente configurado — secret do Worker ou, na falta, o valor cadastrado
 * pelo painel /saas (src/lib/platform-settings.ts). Sem API key em nenhuma das
 * duas fontes o sistema fica "nao_configurado" (cobrança desabilitada, o
 * resto segue funcionando).
 */
export async function asaasEnvironment(): Promise<"sandbox" | "producao" | "nao_configurado"> {
  const { credenciaisAsaas } = await import("./platform-settings");
  const cred = await credenciaisAsaas();
  if (!cred.apiKey) return "nao_configurado";
  return cred.environment === "production" ? "producao" : "sandbox";
}

export function asaasClient(cfg: AsaasConfig) {
  const doFetch = cfg.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${cfg.baseUrl}${path}`, {
        method,
        headers: {
          access_token: cfg.apiKey,
          "Content-Type": "application/json",
          // Obrigatório: a API do Asaas recusa requisições sem User-Agent
          // (o fetch do Worker NÃO envia um por padrão, ao contrário do curl).
          "User-Agent": "limas-locacoes-saas/1.0",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e: any) {
      throw new AsaasError(`Falha de rede ao falar com o Asaas: ${e?.message ?? e}`, 0);
    }
    const text = await res.text();
    let data: AsaasBody = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      const lista = Array.isArray(data.errors) ? data.errors : [];
      throw new AsaasError(lista[0]?.description || `Asaas HTTP ${res.status}`, res.status, lista);
    }
    return data as T;
  }

  return {
    /**
     * Cria (ou recupera) o cliente Asaas da empresa — idempotente.
     *
     * A busca PRIMEIRO pelo externalReference (`company:<id>`, o vínculo do
     * sistema): garante um cliente por EMPRESA mesmo quando duas empresas
     * compartilham documento (ou estão sem documento, onde cairiam ambas no
     * mesmo cpfCnpj e herdariam o cliente Asaas da outra — vazamento entre
     * tenants na cobrança). O cpfCnpj segue como fallback para registros
     * criados antes do externalReference.
     */
    async ensureCustomer(input: {
      name: string;
      cpfCnpj: string;
      email?: string | null;
      externalReference?: string;
    }): Promise<AsaasCustomer> {
      if (input.externalReference) {
        const porRef = await request<{ data: AsaasCustomer[] }>(
          "GET",
          `/v3/customers?externalReference=${encodeURIComponent(input.externalReference)}`,
        );
        const achadoRef = porRef.data?.[0];
        if (achadoRef) return achadoRef;
      }
      const doc = input.cpfCnpj.replace(/\D/g, "");
      const busca = await request<{ data: AsaasCustomer[] }>("GET", `/v3/customers?cpfCnpj=${doc}`);
      const achado = busca.data?.[0];
      if (achado) return achado;
      return await request<AsaasCustomer>("POST", "/v3/customers", {
        name: input.name,
        cpfCnpj: doc,
        email: input.email ?? undefined,
        externalReference: input.externalReference,
      });
    },

    /**
     * Cria uma cobrança (API v3). Value em reais.
     *
     * `billingType` define a forma: UNDEFINED (pagador escolhe na fatura),
     * PIX, BOLETO ou CREDIT_CARD. NUNCA enviamos dados de cartão — para
     * CREDIT_CARD o pagador paga na fatura hospedada pelo Asaas.
     */
    async createPayment(input: {
      customer: string;
      billingType: MeioCobranca;
      value: number;
      dueDate: string; // YYYY-MM-DD
      description?: string;
      externalReference?: string;
    }): Promise<AsaasPayment> {
      return await request<AsaasPayment>("POST", "/v3/payments", {
        customer: input.customer,
        billingType: input.billingType,
        value: input.value,
        dueDate: input.dueDate,
        description: input.description,
        externalReference: input.externalReference,
      });
    },

    /**
     * Cobranças de uma externalReference (idempotência): se uma criação
     * anterior falhou DEPOIS de o Asaas gravar (timeout na resposta), a
     * retentativa encontra a cobrança existente em vez de duplicar.
     */
    async listPaymentsByExternalReference(externalReference: string): Promise<AsaasPayment[]> {
      const r = await request<{ data?: AsaasPayment[] }>(
        "GET",
        `/v3/payments?externalReference=${encodeURIComponent(externalReference)}&limit=100`,
      );
      return Array.isArray(r.data) ? r.data : [];
    },

    /**
     * Linha digitável + código de barras de um boleto
     * (GET /v3/payments/{id}/identificationField — guia oficial de boleto).
     */
    async getBankSlipLine(paymentId: string): Promise<{
      identificationField?: string | null;
      barCode?: string | null;
    }> {
      return await request("GET", `/v3/payments/${paymentId}/identificationField`);
    },

    /**
     * QR Code Pix de uma cobrança (GET /v3/payments/{id}/pixQrCode):
     * encodedImage (base64), payload (copia e cola) e expirationDate.
     */
    async getPixQrCode(paymentId: string): Promise<{
      encodedImage?: string | null;
      payload?: string | null;
      expirationDate?: string | null;
    }> {
      return await request("GET", `/v3/payments/${paymentId}/pixQrCode`);
    },

    /** Busca a cobrança por id (conciliação de status). */
    async getPayment(id: string): Promise<AsaasPayment> {
      return await request<AsaasPayment>("GET", `/v3/payments/${id}`);
    },

    /**
     * Sonda de credencial: bate em /v3/payments com limit=1 (leitura barata,
     * presente em sandbox e produção). Serve para o painel CONFIRMAR que a
     * chave cadastrada funciona de verdade — 200 = chave válida no ambiente;
     * 401 = chave recusada pelo Asaas; erro de rede = inalcançável.
     */
    async testarCredencial(): Promise<{ ok: boolean; status: number; mensagem: string }> {
      try {
        const r = await request<{ data?: unknown[] }>("GET", "/v3/payments?limit=1");
        return { ok: true, status: 200, mensagem: `Credencial aceita — ${Array.isArray(r.data) ? r.data.length : 0} cobrança(s) visíveis nesta conta.` };
      } catch (e) {
        if (e instanceof AsaasError) {
          const detalhe = e.errors?.[0]?.description ? ` — ${e.errors[0].description}` : "";
          return { ok: false, status: e.status, mensagem: `Asaas recusou a credencial (HTTP ${e.status})${detalhe}` };
        }
        return { ok: false, status: 0, mensagem: e instanceof Error ? e.message : "Falha desconhecida ao falar com o Asaas." };
      }
    },
  };
}
