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
  invoiceUrl?: string | null;
  invoiceNumber?: string | null;
};

export const ASAAS_SANDBOX = "https://api-sandbox.asaas.com";
export const ASAAS_PRODUCAO = "https://api.asaas.com";

type AsaasBody = { errors?: { code: string; description: string }[] } & Record<string, any>;

/** Ambiente configurado nos secrets do Worker (nunca no cliente). */
export async function asaasEnvironment(): Promise<"sandbox" | "producao" | "nao_configurado"> {
  try {
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    const env = getCloudflareContext().env;
    if (!env.ASAAS_API_KEY) return "nao_configurado";
    return env.ASAAS_ENVIRONMENT === "production" ? "producao" : "sandbox";
  } catch {
    return "nao_configurado";
  }
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
     * Cria (ou recupera) o cliente Asaas da empresa — idempotente por
     * cpfCnpj: a busca antes do POST evita duplicar cadastro em retries.
     */
    async ensureCustomer(input: {
      name: string;
      cpfCnpj: string;
      email?: string | null;
      externalReference?: string;
    }): Promise<AsaasCustomer> {
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

    /** Cria cobrança PIX (billingType=PIX). Value em reais (Asaas v3). */
    async createPixPayment(input: {
      customer: string;
      value: number;
      dueDate: string; // YYYY-MM-DD
      description?: string;
      externalReference?: string;
    }): Promise<AsaasPayment> {
      return await request<AsaasPayment>("POST", "/v3/payments", {
        customer: input.customer,
        billingType: "PIX",
        value: input.value,
        dueDate: input.dueDate,
        description: input.description,
        externalReference: input.externalReference,
      });
    },

    /** Busca a cobrança por id (conciliação de status). */
    async getPayment(id: string): Promise<AsaasPayment> {
      return await request<AsaasPayment>("GET", `/v3/payments/${id}`);
    },
  };
}
