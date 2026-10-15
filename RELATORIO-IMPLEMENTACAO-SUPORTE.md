# RELATÓRIO — Implementação do Suporte (respeitando os planos)

> Escopo: analisar o projeto inteiro e descrever **como o suporte seria implementado e
> como funcionaria na prática**, com a restrição comercial de que **"suporte prioritário"
> é item exclusivo do plano Empresarial**.

---

## 1. Resumo executivo

1. **Hoje não existe módulo de suporte.** O recurso `suporte` já está registrado na matriz
   comercial (`src/lib/planos.ts` → `RECURSOS.suporte = { nome: "Suporte prioritário", minimo: "empresarial", fundamental: false }`),
   com o próprio comentário do código: *"Sem módulo próprio no sistema hoje: registrado para
   a oferta não se perder da matriz"*. Existe teste fixando isso
   (`tests/planos-recursos.test.ts` → *"suporte prioritário: sem módulo próprio hoje, mas presente na matriz"*).
   Não há tabela, rota, tela, fila nem API de suporte.
2. **Os demais planos não ficam "sem suporte".** O que é exclusivo do Empresarial é o
   **nível prioritário** (fila com prioridade / SLA curto). Um atendimento básico (abrir
   chamado, acompanhar resposta) **deve ser fundamental — disponível a todos os planos** —
   porque o próprio `planos.ts` documenta a regra: *"não inventamos limitações comerciais
   fora da oferta"*. Nenhum plano promete "sem suporte"; só o Empresarial promete
   "suporte **prioritário**" (descrição na migration `0029_saas_billing.sql` e na landing `/planos`).
3. **Solução recomendada: dois níveis, uma porta só.** A tela de suporte abre para todo
   mundo (fundamental); a **prioridade na fila é calculada a partir da matriz**
   (`recursoLiberado(companyId, "suporte")`), nunca por `if (plano === "empresarial")`.
   Assim a regra de ouro do projeto se mantém: a matriz comercial vive **só** em `planos.ts`.

---

## 2. O que existe hoje (evidências no código)

| Área | Achado | Arquivo |
|---|---|---|
| Matriz de planos | Recurso `suporte` criado, `minimo: "empresarial"`, sem módulo por trás | `src/lib/planos.ts` |
| Oferta pública | "Suporte prioritário" aparece só no card Empresarial | `src/app/planos/page.tsx` (DESTAQUES) |
| Catálogo | Descrição do Empresarial cita "suporte prioritário"; Essencial e Profissional não citam suporte | `migrations/0029_saas_billing.sql` |
| Teste | `RECURSOS.suporte.minimo === "empresarial"` travado | `tests/planos-recursos.test.ts` |
| Tabelas | Nenhuma tabela de chamados/tickets em nenhuma migration (0001–0040) | `migrations/` |
| Atendimento | Só textos de ajuda ("Fale com o suporte") em mensagens de erro | `src/app/(app)/faturamento/actions.ts`, `src/lib/onboarding.ts` |
| Autoatendimento | FAQ estático na landing pública | `src/app/page.tsx` |
| Diagnóstico | "Diário de erros" (`/erros`) — empresa vê os próprios erros, plataforma vê o global | `src/app/(app)/erros/page.tsx`, `src/lib/error-log.ts` |
| Auditoria | Log global da plataforma já descreve "ações comerciais e de suporte" | `src/app/(saas)/saas/atividade/page.tsx` |
| E-mail | Transacional via Resend, fail-open (`RESEND_API_KEY`/`RESEND_FROM`) | `src/lib/email.ts` |
| Notificações | Central + push + `notification_rules` (padrão: chat entrou como tipo novo) | `migrations/0006_operational_push.sql`, `0014_chat.sql` |
| Referência arquitetural | Chat 1:1 com anexos, não-lidas por cursor, rota própria de arquivo com checagem de participação | `migrations/0014_chat.sql`, `src/app/api/chat/` |
| WhatsApp | Só cliente-final (reservas/orçamentos); não é canal de suporte | `src/lib/whatsapp.ts` |

### Gates que o novo módulo vai herdar (já prontos)

- **Papel (quem mexe):** `roles.ts` — `requireModule` (página) / `requireModuleEdit` (action).
- **Plano (o que existe):** `plano-gate.ts` — `temRecurso`/`exigirRecurso`; páginas caem em `/plano-restrito`, actions lançam `RecursoNaoContratadoError`, `/api` responde 403 `recurso_nao_contratado` via `apiUser()` (`src/lib/api-security.ts`).
- **Assinatura (conta em ordem):** `assinatura-gate.ts` — 402 nas APIs, redirect para `/assinatura-bloqueada` nas páginas.
- **Multi-tenant:** todo escopo vem de `company_id` da sessão, nunca de parâmetro do cliente.
- **Personalização:** overrides/cortesias (migration 0039) já entram na precedência `resolverPermissao` — um cliente Essencial com **liberação admin** ou **cortesia Empresarial** já cai na prioridade alta automaticamente.

---

## 3. Resposta direta: os demais planos não terão suporte?

**Não — terão. A distinção correta é por NÍVEL, não por presença/ausência:**

- **Nível 1 — Atendimento básico (fundamental, TODOS os planos):**
  abrir chamado, anexar print/arquivo, acompanhar a conversa, receber resposta,
  FAQ/autoatendimento, Diário de erros. É *uso corriqueiro do sistema*, não item da oferta —
  tratá-lo como pago seria **inventar uma limitação comercial fora da oferta**, o que o
  cabeçalho de `planos.ts` proíbe explicitamente. Além disso, há um motivo prático forte:
  mensagens de erro do próprio sistema já mandam o cliente "falar com o suporte"
  (ex.: `asaas_nao_configurado` em `faturamento/actions.ts`) — bloquear o canal para
  quem tem problema de **cobrança** seria um tiro no pé.
- **Nível 2 — Suporte prioritário (recurso `suporte`, EMPRESARIAL+):**
  os chamados dessa empresa entram **no topo da fila**, com SLA de primeira resposta
  curto, selo visível na tela do cliente e na fila da plataforma, e (opcional) canal
  direto/e-mail dedicado. É exatamente o que a oferta promete — *"Atendimento com
  prioridade na fila de suporte"* (descrição do recurso em `planos.ts`).

**Se a intenção comercial for mesmo privar Essencial/Profissional de atendimento humano**,
isso precisa antes ser escrito na oferta (descrição dos planos/landing) — hoje nada
diz isso. Mesmo nesse caso, a **única** forma aritmeticamente correta dentro do sistema
atual é a **Opção B** da seção 5.2 (travar a porta com o recurso `suporte`), que já
nasce pronta porque o recurso está na matriz.

### Alerta importante (estado de bloqueio)

Com assinatura `suspended`/`canceled`/trial expirado, o gate de assinatura manda **toda**
a área autenticada para `/assinatura-bloqueada` — ou seja, o cliente mais precisando de
ajuda (inadimplente) **perde o acesso ao módulo de suporte**. A tela de bloqueio hoje não
oferece nenhum canal de contato. Recomendação embutida neste plano: **a tela
`/assinatura-bloqueada` ganha o canal de contato do suporte (e-mail/WhatsApp da plataforma)**
e o e-mail de bloqueio também — o suporte nunca pode ficar atrás do próprio bloqueio.

---

## 4. Como funcionaria na prática (produto)

### 4.1 Lado da empresa (locadora) — `/suporte`

- **Lista de chamados:** card com assunto, categoria, status, data, badge de prioridade
  ("Prioritário" só aparece para quem tem o recurso), contador de não lidas no menu (padrão chat).
- **Novo chamado:** categoria (`erro`, `cobranca`, `duvida`, `sugestao`), assunto, descrição,
  anexos (print/log — mesma tabela `files` do chat), e um **contexto automático anexado**:
  plano/assinatura da empresa + erros recentes do Diário de erros (diagnóstico sem o cliente
  precisar descrever o que aconteceu).
- **Conversa:** mensagens com os dois lados (empresa ↔ suporte), status
  `aberto → em_andamento → aguardando_empresa → resolvido → reaberto`.
- **Notificação:** sino/push quando o suporte responde (novo tipo em `notification_rules`,
  mesmo caminho do tipo `chat`) + e-mail Resend (fail-open).

### 4.2 Lado da plataforma — `/saas/suporte` (fila única)

- Fila com **todas** as empresas (guard `requirePlatformAdmin` já existe no layout do grupo `(saas)`).
- **Ordenação por prioridade derivada da matriz:** primeiro os chamados de empresas com
  `recursoLiberado(companyId, "suporte") === true` (Empresarial, ou liberado/cortesia),
  depois por abertura. Selo "Prioritário" + SLA visível (ex.: meta de 2h vs 24h).
- Ações: responder, trocar status, marcar resolvido, ver a empresa (plano, assinatura,
  última cobrança) e os erros recentes dela — tudo já existe em `/saas/empresas/[id]`.
- Toda ação registra `logAction` (auditoria) — a tela `/saas/atividade` já espera esse dado.

### 4.3 Fluxos do dia a dia

1. **Bug no uso:** operacional encontra erro → menu **Suporte** → "Novo chamado" →
   anexa print → recebe push em minutos → conversa resolve → status resolvido → audit log.
2. **Fila da plataforma:** suporte abre `/saas/suporte` → vê Empresariais no topo →
   responde → cliente é notificado (push + e-mail).
3. **Erro vira chamado:** em `/erros`, botão "Abrir chamado de suporte" pré-preenche
   assunto/descrição com rota, mensagem e digest do erro.
4. **Cliente bloqueado (inadimplente):** cai em `/assinatura-bloqueada` → vê o canal de
   contato do suporte (seção 3) → o chamado é aberto por e-mail com prioridade "cobrança".

---

## 5. Implementação técnica (passo a passo)

### 5.1 Banco — `migrations/0041_suporte.sql`

```sql
CREATE TABLE support_tickets (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  created_by      INTEGER NOT NULL REFERENCES users(id),
  category        TEXT NOT NULL CHECK (category IN ('erro','cobranca','duvida','sugestao')),
  subject         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'aberto'
                  CHECK (status IN ('aberto','em_andamento','aguardando_empresa','resolvido')),
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','prioritario')),
  plano_abertura  TEXT,                       -- slug congelado (histórico/SLA)
  context         TEXT,                       -- JSON: plano, assinatura, erros recentes
  first_response_at TEXT,
  resolved_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_support_tickets_company ON support_tickets(company_id, status, created_at DESC);
CREATE INDEX idx_support_tickets_queue   ON support_tickets(status, priority, created_at);

CREATE TABLE support_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id  INTEGER REFERENCES users(id),   -- null = plataforma/sistema
  author_kind TEXT NOT NULL CHECK (author_kind IN ('empresa','suporte')),
  body       TEXT NOT NULL,
  file_id    TEXT REFERENCES files(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX idx_support_msg_ticket ON support_messages(ticket_id, id);

INSERT INTO notification_rules (type, enabled, offsets, message)
VALUES ('suporte', 1, '[0]', '') ON CONFLICT(type) DO NOTHING;
```

- `priority` é **gravada na abertura** a partir da matriz (campo `plano_abertura` congela o
  contexto), mas a **fila sempre reordena pelo estado atual** (`recursoLiberado`), para que
  uma troca de plano/cortesia surta efeito imediato.

### 5.2 Gate: duas opções (recomendada a A)

**Opção A — recomendada (porta única, prioridade calculada):**
- `/suporte` **não** entra em `recursoDoCaminho` nem `/api/suporte` em `recursoDaApi`
  (não são mapeados → nada pago a verificar → fundamental por padrão);
- novo módulo `suporte` em `roles.ts` (VIEW: todos os papéis; EDIT: owner/admin/operacional/financeiro — viewer só lê) **sem** entrada em `RECURSO_DO_MODULO` do `plano-gate.ts`
  → `requireModule("suporte")` checa só papel;
- a exclusividade Empresarial aparece **no resultado** (`priority`, selo, ordenação da fila,
  SLA), calculada por `recursoLiberado(companyId, "suporte")` (`src/lib/plano-personalizado.ts`).
- Vantagem: todos atendidos (regra da oferta), personalização/cortesia funcionam sem código novo,
  nenhuma comparação de slug fora de `planos.ts`.

**Opção B — leitura literal (só Empresarial abre chamado):**
- mapear `["/suporte", "suporte"]` em `recursoDoCaminho` e `/api/suporte` em `recursoDaApi`
  (o resto do gate já está pronto: `/plano-restrito?recurso=suporte` e 403 saem de graça);
- demais planos ficam com FAQ + `/erros` + e-mail.
- Risco comercial: cliente com problema de cobrança no Essencial fica sem canal interno.

> Qualquer que seja a opção, **nenhum arquivo novo pode comparar slug**: prioridade e visibilidade
> saem da matriz (`planos.ts`) — é regra documentada e há teste estático defendendo o desenho.

### 5.3 Backend — `src/lib/suporte.ts`

- `abrirChamado(user, dados)` — valida, grava `priority`/`plano_abertura` via matriz, `logAction`.
- `responderChamado(user | plataforma, ticketId, texto, fileId)` — escreve, atualiza status/SLA, notifica.
- `listarChamados(companyId)` (escopo tenant) e `filaPlataforma(filtros)` (global, ordenada por prioridade).
- Escopo **sempre** por `company_id` da sessão (padrão do repositório; espelhar `chat.ts`).
- Anexos: rota `src/app/api/suporte/arquivo/[id]/route.ts` com checagem de participação
  (copiar `src/app/api/chat/arquivo/[id]/route.ts`); a rota pública `/api/arquivo` não serve anexos de suporte.

### 5.4 UI

- **Empresa:** `src/app/(app)/suporte/page.tsx` + `actions.ts` (server actions, padrão do projeto),
  item no `NAV` de `src/lib/nav.ts` (fora da barra mobile — cabe no "Mais"), ícone em `Icons.tsx`.
- **Plataforma:** `src/app/(saas)/saas/suporte/page.tsx` + entrada em `SAAS_NAV`
  (o guard server-side do layout do `(saas)` já existe — mesmo padrão de `/saas/atividade`).
- Badge de prioridade reaproveitando `Badge` de `src/components/ui`.

### 5.5 Notificações e e-mail

- Sino/não-lidas: reaproveitar o padrão de `chat-unread.ts` / `use-unread.ts` (cursor por participante → aqui, por ticket).
- Push: novo tipo `suporte` já nasce no `notification_rules` (como fez a migration do chat).
- E-mail de resposta via `enviarEmail` (`src/lib/email.ts`) — **fail-open**: sem `RESEND_*`
  configurado nada quebra e a causa aparece no Diário de erros (contrato atual do módulo).

### 5.6 Testes (espelhar a suíte existente)

- `tests/planos-recursos.test.ts`: prioridade derivada da matriz para os 3 planos; cortesia/liberação admin derrubam a empresa para "prioritário" sem trocar plano.
- `tests/autorizacao-matriz.test.ts`: papel viewer não escreve; operacional abre chamado (Opção A) / é redirecionado (Opção B).
- `tests/leitura-multi-tenant.test.ts`: empresa 1 não lê chamados da empresa 2 (escrita e leitura).
- `tests/assinatura-gate.test.ts`: tela de bloqueio segue exibindo o canal de suporte.
- Teste estático de desenho (padrão do arquivo `planos-recursos.test.ts` linha ~634): `suporte.ts` não contém `plano === "empresarial"`.

---

## 6. Fases sugeridas

| Fase | Entrega | Esforço |
|---|---|---|
| **1 — Núcleo** | Migration, `suporte.ts`, tela da empresa, fila `/saas/suporte`, prioridade pela matriz, roles, audit | médio (espelha chat + módulos existentes) |
| **2 — Alcance** | Sino/push, e-mail Resend, botão "abrir chamado" em `/erros`, canal na tela de bloqueio | pequeno |
| **3 — Operação** | Métricas de SLA (1ª resposta/resolução) no `/saas`, relatório por empresa, anexos de contexto automático | pequeno/médio |

---

## 7. Riscos e pontos de atenção

1. **Não travar o suporte atrás do gate de assinatura** — cliente suspenso é justamente quem
   precisa (seção 3): manter `/assinatura-bloqueada` com canal de contato.
2. **Não hardcodar plano** — qualquer `if (plano === "empresarial")` fora de `planos.ts`
   quebra a "fonte única de verdade" e a personalização por empresa (overrides/cortesias).
3. **Fail-open do e-mail** — notificação por e-mail nunca pode ser etapa obrigatória do fluxo.
4. **Escopo tenant** — `company_id` sempre da sessão; fila da plataforma é a única visão global.
5. **Anexos** — arquivos de suporte fora da rota pública `/api/arquivo` (padrão já adotado pelo chat).
6. **Oferta** — se a Opção B for escolhida, atualizar descrições da migration de catálogo
   (via painel/`plans.description`) e a landing `/planos` para dizer o que cada plano inclui.
7. **Rate limit** — usar `rateLimit` existente (`src/lib/rate-limit.ts`) na abertura de chamados.
