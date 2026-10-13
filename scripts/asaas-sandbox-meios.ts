/**
 * Smoke test das três modalidades no SANDBOX do Asaas (Fase 4).
 *
 * REGRAS DE SEGURANÇA:
 *  * baseUrl é SEMPRE https://api-sandbox.asaas.com — o script aborta se o
 *    .dev.vars.saas marcar ASAAS_ENVIRONMENT diferente de "sandbox";
 *  * a API key nunca é impressa (só "presente/ausente");
 *  * valor simbólico (R$ 5,00 — mínimo aceito pelo Asaas) e descrição marcada
 *    como teste;
 *  * nada de webhook, e-mail ou notificação — só criação e consulta.
 *
 * Uso: npx tsx --conditions=react-server scripts/asaas-sandbox-meios.ts
 */
import fs from "node:fs";

const SANDBOX = "https://api-sandbox.asaas.com";

function lerEnv(): { apiKey: string; environment: string } {
  const bruto = fs.readFileSync(".dev.vars.saas", "utf8");
  const valor = (chave: string) =>
    bruto
      .split(/\r?\n/)
      .find((l) => l.startsWith(`${chave}=`))
      ?.slice(chave.length + 1)
      .trim() ?? "";
  return { apiKey: valor("ASAAS_API_KEY"), environment: valor("ASAAS_ENVIRONMENT") };
}

const env = lerEnv();
if (!env.apiKey) {
  console.error("ASAAS_API_KEY ausente em .dev.vars.saas — nada a validar.");
  process.exit(2);
}
if (env.environment !== "sandbox") {
  console.error(`ABORTADO: ASAAS_ENVIRONMENT=${env.environment} (não é "sandbox"). Nenhuma chamada foi feita.`);
  process.exit(2);
}
console.log(`Chave: presente (oculta). Ambiente declarado: ${env.environment}. Base URL forçada: ${SANDBOX}`);

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${SANDBOX}${path}`, {
    method,
    headers: {
      access_token: env.apiKey,
      "Content-Type": "application/json",
      "User-Agent": "limas-locacoes-saas/1.0",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const texto = await res.text();
  let dados: any = {};
  try {
    dados = texto ? JSON.parse(texto) : {};
  } catch {
    dados = { raw: texto.slice(0, 200) };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} em ${method} ${path}: ${JSON.stringify(dados.errors ?? dados).slice(0, 300)}`);
  }
  return dados;
}

type Resultado = { meio: string; ok: boolean; detalhe: string };

async function main() {
  const resultados: Resultado[] = [];

  // 0) credencial
  const probe = await api("GET", "/v3/payments?limit=1");
  console.log(`\n[0] Credencial aceita — ${Array.isArray(probe.data) ? probe.data.length : 0} cobrança(s) visíveis.\n`);

  // 1) cliente de teste (externalReference única de teste)
  const ref = `sandbox-teste-meios:${Date.now()}`;
  const cliente = await api("POST", "/v3/customers", {
    name: "Cliente Teste Meios Sandbox",
    cpfCnpj: "11144477735",
    externalReference: ref,
  });
  console.log(`[1] Cliente de teste criado: ${cliente.id}\n`);

  const vencimento = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  const meios = ["PIX", "BOLETO", "CREDIT_CARD", "UNDEFINED"] as const;

  for (const meio of meios) {
    try {
      const payment = await api("POST", "/v3/payments", {
        customer: cliente.id,
        billingType: meio,
        value: 5.0, // mínimo do sandbox: R$ 5,00 (regra do Asaas)
        dueDate: vencimento,
        description: `TESTE SANDBOX meios de pagamento (${meio}) — nao pagar`,
        externalReference: `${ref}:${meio}`,
      });
      const detalhes: string[] = [`id=${payment.id}`, `status=${payment.status}`, `billingType=${payment.billingType}`];
      detalhes.push(`invoiceUrl=${payment.invoiceUrl ?? "—"}`);

      const consultado = await api("GET", `/v3/payments/${payment.id}`);
      detalhes.push(`getPayment.status=${consultado.status}`);

      if (meio === "BOLETO") {
        try {
          const linha = await api("GET", `/v3/payments/${payment.id}/identificationField`);
          detalhes.push(`linhaDigitavel=${linha.identificationField ?? "—"}`);
          detalhes.push(`barCode=${linha.barCode ? "presente" : "—"}`);
          detalhes.push(`bankSlipUrl=${payment.bankSlipUrl ?? consultado.bankSlipUrl ?? "—"}`);
        } catch (e: any) {
          detalhes.push(`identificationField=FALHOU (${e.message})`);
        }
      }
      if (meio === "PIX" || meio === "UNDEFINED") {
        try {
          const qr = await api("GET", `/v3/payments/${payment.id}/pixQrCode`);
          detalhes.push(`pix.payload=${qr.payload ? "presente" : "ausente"}`);
          detalhes.push(`pix.encodedImage=${qr.encodedImage ? "presente" : "ausente"}`);
        } catch (e: any) {
          detalhes.push(`pixQrCode=FALHOU (${e.message})`);
        }
      }

      resultados.push({ meio, ok: true, detalhe: detalhes.join(" | ") });
      console.log(`[${meio}] OK — ${detalhes.join(" | ")}`);
    } catch (e: any) {
      resultados.push({ meio, ok: false, detalhe: e.message });
      console.log(`[${meio}] FALHOU — ${e.message}`);
    }
  }

  console.log("\n=== Resumo ===");
  for (const r of resultados) console.log(`${r.ok ? "OK  " : "ERRO"} ${r.meio}`);
  const falhas = resultados.filter((r) => !r.ok).length;
  console.log(`\n${resultados.length - falhas}/${resultados.length} modalidades validadas em sandbox.`);
  process.exit(falhas > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Falha no smoke test:", e.message);
  process.exit(1);
});
