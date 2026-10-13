# Relatório de auditoria — Resend, e-mails transacionais, domínio próprio e Asaas

**Data:** 2026-10-13 · **Branch:** `audit/resend-email-asaas` (sem commit, sem push, sem deploy)
**Escopo:** Locô — Gestão para Locações (Cloudflare Workers + OpenNext + D1, `limas-saas` / `limas-saas-staging`)

---

## A. Resumo executivo

A implementação de e-mails está **tecnicamente correta** (fail-open com visibilidade, sem destinatários fixos, sem fallback de remetente, templates e deduplicação adequados). Três problemas reais foram encontrados e corrigidos no código:

1. **`RESEND_FROM` ainda aponta para `resend.dev` nos ambientes** (staging e produção) — causa raiz do erro reportado. É configuração em secret, não em código. Staging foi corrigido e validado com envio real; produção permanece pendente.
2. **Todo e-mail gerado pelo cron era pulado** com motivo `sem_contexto` (evidência em produção, 2026-10-13 03:00). Corrigido.
3. **A rotina diária do cron nunca conseguia gerar cobrança** — as credenciais do Asaas ficavam ilegíveis fora de request. Corrigido (com efeito real: passa a cobrar automaticamente).

A restrição de enviar **somente para o dono da conta Resend** era imposta pelo **provedor** (domínio de teste `resend.dev`), não pelo código. Com o domínio próprio `locogestao.com.br` — cujos registros DNS do Resend **já estão publicados** — a limitação desaparece: o teste real de 13/10 aceitou envio para um endereço externo.

**Risco em aberto:** o Asaas envia notificações de cobrança **direto ao cliente por padrão** (clientes criados via API nascem com elas habilitadas). Somado aos e-mails do Locô, há **duplicidade real** a decidir (ver seção I e L).

---

## B. Diagnóstico do erro `RESEND_FROM`

**Onde nasce a mensagem:** [src/lib/email.ts](src/lib/email.ts) — `MENSGENS.remetente_dev`, acionada por `montarConfigEmail()` quando `RESEND_FROM` casa com `/@resend\.dev\b/i`. A causa é gravada no diário de erros (`registrarErro` → tela `/erros`) e no `console.error` do Worker. A validação está **correta** e **foi mantida** (não é possível usá-la para burlar o domínio de teste).

**De onde vem o valor:** exclusivamente do **secret do Worker** (`wrangler secret put RESEND_FROM --env <ambiente>`). O código não tem remetente padrão — o fallback `onboarding@resend.dev` foi removido na pendência #08.

**Evidências coletadas (somente leitura):**

| Ambiente | Linha | Data (UTC) | Assunto | Motivo |
|---|---|---|---|---|
| produção | 17 | 2026-10-12 15:46 | Bem-vindo(a) ao Locô | `remetente_dev` |
| produção | 12 | 2026-10-10 21:21 | Cobrança gerada — Locô | `remetente_dev` |
| staging | 12–15 | 2026-10-10 | Redefinição de senha / Boas-vindas / Cobrança | `remetente_dev` |
| staging | 4 | 2026-10-06 21:55 | Cobrança gerada — Locô | **403 do Resend**: *"You can only send testing emails to your own email address (uericlislima@gmail.com)… change the from address"* |

A última linha é a **confirmação do provedor**: enquanto o remetente for `Lima's Locacoes <onboarding@resend.dev>`, o Resend recusa destinatários externos.

**Staging × produção:** ambos usavam `resend.dev`. Desenvolvimento local ([.dev.vars.saas](.dev.vars.saas)) também usa `onboarding@resend.dev` (com espaços duplos, o que o `check:secrets` reprova) — é de lá que sai o mesmo erro no `next dev`.

**Correção realizada (staging, autorizada):**

```bash
npx wrangler secret put RESEND_FROM --env staging
# valor: Locô — Gestão para Locações <contato@locogestao.com.br>
```

**Produção:** pendência nº 1 (seção L) — não toquei no ambiente de produção.

---

## C. Inventário de e-mails

Todos usam o mesmo par `RESEND_API_KEY` + `RESEND_FROM`, o mesmo módulo (`enviarEmail`) e a mesma API (`POST https://api.resend.com/emails`). **Não há `reply_to`, webhook, fila ou retry.** Nenhum destinatário fixo ou allowlist — todo destinatário vem do banco.

| # | Gatilho | Arquivo/função | Destinatário | Template | Link | Falha |
|---|---|---|---|---|---|---|
| 1 | Cadastro público (checkout `/assinar`) | [src/app/assinar/actions.ts](src/app/assinar/actions.ts) → `enviarBoasVindasCheckout` | e-mail do cadastro | `emailBoasVindas` | `${baseUrl}/dashboard` | fail-open |
| 2 | Primeiro acesso `/setup` | [src/app/setup/actions.ts](src/app/setup/actions.ts) → `enviarBoasVindasSetup` | e-mail do cadastro | `emailBoasVindasSetup` | `${url}/login` | fail-open |
| 3 | Pedido de redefinição de senha | [src/lib/recuperacao.ts](src/lib/recuperacao.ts) `pedirRedefinicao` | e-mail **cadastrado na conta** | `emailHtml` | `${base}/redefinir-senha?token=…` | fail-open |
| 4 | Cron: trial acabando (3 dias) | [src/lib/billing.ts](src/lib/billing.ts) `avisarTrial('expirando')` | e-mail do 1º owner ativo | `emailTrialExpirando` | `${PUBLIC_URL}/faturamento` | fail-open + dedupe `billing_alerts` |
| 5 | Cron: trial expirado | idem `avisarTrial('expirado')` | owner | `emailTrialExpirado` | `${PUBLIC_URL}/faturamento` | idem |
| 6 | Cobrança gerada (painel/faturamento/cron) | `gerarCobrancaPeriodo` | owner | `emailCobrancaGerada` | fatura do Asaas | fail-open |
| 7 | Webhook `PAYMENT_CONFIRMED` | `processarEventoPayment` | owner | `emailPagamentoConfirmado` | — | fail-open |

Condições que **impedem** o envio (todas registradas em `/erros`): `sem_contexto`, `sem_api_key`, `sem_remetente`, `remetente_dev`; além de erro HTTP/rede da API (registrado com status e corpo truncado, nunca com a chave).

---

## D. Recuperação de senha

**A arquitetura está correta** e foi validada pelos testes existentes ([tests/recuperacao.test.ts](tests/recuperacao.test.ts)): identificador CPF/CNPJ/e-mail → conta ATIVA com e-mail → token opaco de 256 bits (só o SHA-256 vai ao banco), validade de 1 h, uso único, uma tentativa ativa por conta, encerramento de sessões antigas, auditoria em `audit_log`, rate limit por IP e por identificador (3/15 min) e **resposta sempre idêntica** (sem oráculo de contas). A página `/redefinir-senha` só age com `?token=` válido.

**Causa da falha reportada:** o remetente (`remetente_dev`) e, antes dele, o 403 do Resend — nada quebrado no código.

**Validação real (2026-10-13, staging):**
1. Secret `RESEND_FROM` atualizado para o domínio próprio.
2. Formulário de `/recuperar-senha` enviado para `uericlislima@icloud.com` → mensagem de sucesso (anti-enumeração preservada).
3. `password_resets` em staging: **linha nova** (id 3, hash de 64 chars, expiração exatamente +1 h) → conta localizada e envio disparado.
4. `error_logs` (últimos 15 min): **nenhuma linha** — como o design registra toda falha de config e de API, ausência de linha = `enviarEmail` devolveu `true` = **Resend aceitou a mensagem**.

**Limite honesto:** aceitação da API ≠ caixa de entrada. A entrega ao iCloud precisa ser confirmada por você (caixa/spam) e pelo **Logs** do Resend.

---

## E. E-mail de boas-vindas

Comportamento: disparado **após** a persistência (empresa → owner → settings → regras → trial), **antes** do `redirect`, de forma assíncrona. O destinatário é **sempre** o e-mail do cadastro (`resultado.email`), nunca fixo. Não envia senha nem token.

Mudanças desta auditoria:
- extração de `enviarBoasVindasCheckout` / `enviarBoasVindasSetup` em [src/lib/email.ts](src/lib/email.ts) (as actions passaram a chamá-las) — mesmo comportamento, agora testável de ponta a ponta;
- **8 testes novos** ([tests/boas-vindas.test.ts](tests/boas-vindas.test.ts)) que cobrem exatamente os critérios pedidos: destinatário vem do cadastro (dois clientes distintos → dois destinatários distintos), link correto por ambiente, `HTTP 500`/queda de rede/sem config → `false` sem lançar **e conta persistida com trial intacto**, e ausência de duplicidade (requisição repetida recusada antes de gravar → um só e-mail).

---

## F. Restrição de destinatários

1. **Ainda existe restrição a um único endereço?** Não, depois da correção do remetente.
2. **Causa:** o **código não restringe nada**; a restrição vinha do **provedor**, por usar o domínio de teste `resend.dev` (documentação oficial: *403 Error Using resend.dev Domain*).
3. **Correção:** `RESEND_FROM` de staging apontado para `locogestao.com.br` + envio real aceito para endereço externo (`uericlislima@icloud.com`).
4. **Para liberar em produção:** atualizar o secret de produção (seção L.1). Não há "modo de teste" da conta a liberar: segundo a documentação, contas Resend (inclusive gratuitas) têm acesso de produção imediato — a limitação era só do domínio.

---

## G. Domínio e DNS (`locogestao.com.br`)

Estado **observado** (consultas DNS públicas, 2026-10-13):

| Registro | Nome | Tipo | Valor observado | Situação |
|---|---|---|---|---|
| Nameservers | locogestao.com.br | NS | `abdullah`/`isabel.ns.cloudflare.com` | Cloudflare |
| Site | locogestao.com.br / www | A | IPs proxy Cloudflare (200, app Next.js responde) | OK |
| App | **app.locogestao.com.br** | A/CNAME | **não existe** | se quiser, criar na Cloudflare |
| DKIM Resend | `resend._domainkey` | TXT | chave pública RSA | **presente** |
| Envio Resend | `send` | CNAME | `send.forge.rmta.net` | **presente** |
| SPF do envio | `send` (via alvo) | TXT | `v=spf1 ip4:52.3.252.119 … ~all` | **presente** |
| Feedback | `send` | MX | `feedback.forge.rmta.net` (pref 10) | **presente** |
| DMARC | `_dmarc` | TXT | `v=DMARC1; p=reject;` | **presente** (política rígida) |
| SPF raiz | locogestao.com.br | TXT | `v=spf1 -all` | não conflita (o MAIL FROM do Resend vai para `send.`), mas **não crie um SPF na raiz junto** |

**Remetente adotado:** `Locô — Gestão para Locações <contato@locogestao.com.br>`. O endereço **não precisa existir como caixa postal** — o Resend só exige o domínio verificado; para receber respostas, configure um `reply_to` (hoje não existe) ou uma caixa real.

**Limitação da verificação:** não consigo ler o painel do Resend — a chave local é **send-only** (`GET /domains` → `401 restricted_api_key`). O aceite do envio real de 13/10 é, contudo, evidência forte de que o domínio está **Verified** e com alinhamento DKIM/SPF (domínio não verificado devolve 403).

---

## H. Staging e produção

| Item | staging | produção |
|---|---|---|
| Worker | `limas-saas-staging` | `limas-saas` |
| Secrets presentes (nomes) | ASAAS_*, PAINEL_CHAVE, RESEND_*, VAPID_* | PAINEL_CHAVE, RESEND_*, VAPID_* — **faltam ASAAS_*** |
| `RESEND_FROM` | **atualizado** para `locogestao.com.br` ✔ | ainda `resend.dev` ✖ |
| Credenciais Asaas | secret do Worker | **painel** (`platform_settings`: `asaas_environment=production`) |
| `PUBLIC_URL` | `https://locogestao.com.br` (atualizado) | `https://locogestao.com.br` (atualizado) |

Notas:
- `PUBLIC_URL` foi trocado de `…workers.dev` para `https://locogestao.com.br` em [wrangler.jsonc](wrangler.jsonc) — a raiz **responde a app Next.js** (verificado, HTTP 200). Links de recuperação de senha usam o host da requisição e continuam corretos em qualquer domínio.
- `npm run check:secrets production` **reprova hoje** porque `ASAAS_API_KEY/ENVIRONMENT/WEBHOOK_TOKEN` não existem como secret em produção (o sistema opera pelo painel). Ou você cria os secrets, ou remove esses três de `secrets.required` para produção — decisão sua (não mexi, para não afrouxar proteção sozinho).
- `VAPID_SUBJECT` continua `mailto:uericlislima@gmail.com` (variável pública) — trocar por um e-mail do produto se desejar.

---

## I. Auditoria do Asaas

1. **Beneficiário/emissor:** vem da **conta Asaas** (seus dados cadastrais). O Locô **não envia** nenhum campo de beneficiário — cobrado em teste ([tests/asaas-payload.test.ts](tests/asaas-payload.test.ts): o payload de `/v3/payments` é exatamente `customer, billingType, value, dueDate, description, externalReference`).
2. **O que o cliente vê:** o nome do **titular da conta Asaas** (sua empresa/pessoa) como recebedor, e **"Asaas"** como processador, com a fatura hospedada em `www.asaas.com`. A documentação oficial **não detalha** o rótulo exato exibido — confira visualmente em uma fatura de sandbox.
3. **Dados do beneficiário:** conta Asaas (painel), não controlados pelo código.
4. **Dados do pagador:** `companies.name`, `companies.document` (CNPJ/PF) e `companies.email` → `POST /v3/customers` com `externalReference=company:<id>` (um cliente Asaas por empresa; CPF/CNPJ só como fallback).
5. **Descrição enviada:** `Assinatura <plano> — <empresa>`; valor do plano em reais; vencimento do período; `externalReference=subscription:<id>:<início>` para idempotência.
6. **O Locô aparece?** Nos e-mails enviados pelo Locô e indiretamente na descrição (empresa/plano). Na fatura do Asaas, **não** — a menos que a conta Asaas seja do Locô.
7. **Asaas notifica o cliente?** **Sim.** A documentação diz que clientes criados pela API nascem com notificações de cobrança **habilitadas** (e-mail/SMS; WhatsApp desligado por padrão), configuráveis por cliente (`GET /v3/customers/{id}/notifications`) ou `notificationDisabled: true` na criação.
8. **O Locô envia e-mail de cobrança?** Sim: "Cobrança gerada" e "Pagamento confirmado".
9. **Duplicidade?** **Sim, há risco real** — cliente pode receber a notificação do Asaas e a do Locô. Recomendo desativar as notificações do Asaas ao criar o cliente (uma linha no `ensureCustomer`) ou no painel do Asaas. Não fiz a mudança: é decisão de produto (ver L.5).
10. **Código × conta:** código controla cliente pagador, valor, vencimento, meio, descrição e idempotência; conta controla beneficiário, chave Pix, notificações e visual da fatura.

Sandbox × produção validado por teste: `asaas_environment` do painel escolhe `api-sandbox.asaas.com` × `api.asaas.com`; sem credencial em nenhuma fonte, a cobrança fica `nao_configurado` sem nenhuma chamada de rede. Webhook: token em tempo constante, corpo limitado a 256 KB, idempotência por SHA-256 (`webhook_events`) e fail-closed sem token.

---

## J. Arquivos alterados

| Arquivo | Mudança |
|---|---|
| [src/lib/worker-env.ts](src/lib/worker-env.ts) | **novo** — env do Worker entregue pelo cron; `lerVarWorker()` (request > agendador) |
| [src/lib/email.ts](src/lib/email.ts) | `lerConfig()` e `publicUrlDaPlataforma()` usam o env do agendador fora de request; helpers testáveis `enviarBoasVindasCheckout/Setup` |
| [custom-worker.ts](custom-worker.ts) | `scheduled` chama `definirEnvDoAgendador(env)` — e-mails e links do cron voltam a funcionar |
| [src/lib/platform-settings.ts](src/lib/platform-settings.ts) | `PAINEL_CHAVE` e `ASAAS_*` legíveis fora de request (restaura a cobrança automática do cron) |
| [src/app/assinar/actions.ts](src/app/assinar/actions.ts) / [src/app/setup/actions.ts](src/app/setup/actions.ts) | usam os helpers de boas-vindas (mesmo comportamento) |
| [wrangler.jsonc](wrangler.jsonc) / [.env.example](.env.example) | `PUBLIC_URL` → `https://locogestao.com.br` nos dois ambientes |
| [tests/boas-vindas.test.ts](tests/boas-vindas.test.ts) | **novo** — 8 testes (destinatário do cadastro, fail-open, duplicidade) |
| [tests/asaas-payload.test.ts](tests/asaas-payload.test.ts) | **novo** — 5 testes (pagador, payload, sandbox × produção) |
| [tests/email.test.ts](tests/email.test.ts) / [tests/platform-settings.test.ts](tests/platform-settings.test.ts) | testes do fallback do cron (e-mail + credenciais) |

---

## K. Testes

| Teste | Resultado | Evidência | Limitação |
|---|---|---|---|
| `npx tsc --noEmit` | ✔ | exit 0 | — |
| `npm test` (suíte completa) | ✔ | **1331 testes, 0 falhas** | — |
| `npm run build` | ✔ | exit 0 | — |
| Rejeição de `resend.dev` em produção | ✔ | `montarConfigEmail` → `remetente_dev` (testes) | — |
| Remetente do domínio próprio aceito | ✔ | teste + **envio real aceito no staging** | — |
| Secret ausente / staging×produção | ✔ | `sem_api_key`, `sem_remetente`, `sem_contexto` | — |
| Cron sem contexto de request | ✔ | 4 testes novos (config, PUBLIC_URL, trava `resend.dev` no cron) | — |
| Cadastro + boas-vindas | ✔ | destinatário = cadastro, link correto | — |
| Cadastro sob falha do Resend | ✔ | conta/usuário/trial persistidos, envio `false` | — |
| Sem duplicidade de boas-vindas | ✔ | requisição repetida recusada antes de gravar | — |
| Recuperação de senha | ✔ | testes + **fluxo real em staging** (token +1 h, sem erro) | entrega ao inbox por confirmar |
| Token inválido/expirado/uso único | ✔ | `tests/recuperacao.test.ts` | — |
| Destinatário ≠ dono da conta | ✔ | teste unitário + envio real a endereço externo | — |
| Payload Asaas / pagador / descrição | ✔ | `tests/asaas-payload.test.ts` | — |
| Sandbox × produção | ✔ | host `api-sandbox` × `api.asaas` por teste | — |
| Webhook idempotente | ✔ | `tests/billing-integracao.test.ts` | — |
| Preservação de registros financeiros | ✔ | nenhum INSERT/UPDATE remoto executado | — |
| Entrega da mensagem | ◐ | API aceitou (sem linha de erro) | confirmar no iCloud + Logs do Resend |

---

## L. Pendências externas (você precisa executar/confirmar)

1. **Produção — remetente** (obrigatório):
   ```bash
   npx wrangler secret put RESEND_FROM --env production
   # valor: Locô — Gestão para Locações <contato@locogestao.com.br>
   ```
   (sem espaços duplos no valor; o `check:secrets` reprova esse formato).
2. **Resend → Domains:** confirmar `locogestao.com.br` = *Verified* e que a chave da produção é da mesma conta.
3. **Resend → Logs:** abrir a mensagem de 13/10 ~17:50 UTC para `uericlislima@icloud.com` e conferir *Delivered*; conferir também caixa de entrada e spam do iCloud.
4. **Asaas → Configurações da conta:** conferir o nome do beneficiário que aparece nas faturas e decidir sobre as notificações ao cliente (item 5).
5. **Duplicidade Asaas × Locô:** desativar as notificações de cobrança do Asaas (painel ou `notificationDisabled: true` na criação do cliente — uma alteração de código que posso fazer).
6. **Produção — `ASAAS_*`:** criar os três secrets ou removê-los de `secrets.required` (hoje `check:secrets production` reprova o deploy).
7. **Cloudflare (opcional):** criar `app.locogestao.com.br` se quiser separar app do site — hoje não existe.
8. **Opcional — Resend webhooks:** não existem. Atualmente dá para diagnósticar apenas falha de envio (registrada em `/erros`); entrega/bounce só aparece no painel do Resend. Posso implementar o webhook com validação de assinatura se quiser rastrear entregas e bounces no sistema.

---

## M. Situação final do repositório

- **Branch:** `audit/resend-email-asaas` — criada a partir do HEAD vigente (`feat/configuracoes-locacao-por-empresa`, main + 1 commit) para **não mexer** no tree de trabalho em andamento.
- **Arquivos:** 9 modificados + 3 novos (seção J). Nada foi descartado, revertido ou sobrescrito.
- **Verificações:** `tsc --noEmit` ✔ · `npm test` 1331/1331 ✔ · `npm run build` ✔.

Confirmações exigidas:
- **Nenhum commit realizado.** ✔
- **Nenhum push realizado.** ✔
- **Nenhum deploy realizado.** ✔ (apenas `wrangler secret put` no **staging**, autorizado)
- **Nenhuma alteração direta em produção.** ✔
- **Nenhuma cobrança real criada para testes.** ✔ (Asaas sempre fake em teste; nenhuma chamada de rede ao Asaas)
- **Nenhuma operação destrutiva executada.** ✔ (leituras de D1 com `SELECT`; token de recuperação de staging é de uso único e expira em 1 h)

O que **não** pude validar: conteúdo visual das faturas do Asaas, status exato do domínio no painel do Resend (chave send-only) e a caixa de entrada do destinatário do teste.
