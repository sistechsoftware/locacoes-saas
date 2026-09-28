# Relatório de Auditoria — Transformação em SaaS Multiempresa

> **Etapa 1 do plano (item 55).** Auditoria somente leitura. Nenhuma linha de código foi alterada.
> Base: `main`, commit inicial, workspace limpo (apenas `.freebuff/project-id` modificado, fora do escopo).

---

## 1. Stack atual

| Camada | Tecnologia |
|---|---|
| Frontend/Backend | **Next.js 15.5 (App Router, Turbopack)** + **React 19** + TypeScript 5.7 (strict) |
| Estilo | Tailwind CSS 4 (via `@tailwindcss/postcss`) |
| Runtime | **Cloudflare Workers** via `@opennextjs/cloudflare` 1.20 (`output: "standalone"`) |
| Banco | **Cloudflare D1** (SQLite), binding `DB`, banco `limas-locacoes` (id `79a1d43c-8355-4689-9f11-5ff461e48c58`) |
| Deploy | Wrangler 4 (`deploy:cloudflare` / `preview:cloudflare`), assets em `.open-next/assets` |
| Agendamento | Cron `* * * * *` no `custom-worker.ts` (push scheduler, fidelidade, aniversários, poda de erros) |
| PWA | `manifest.ts` + `public/sw.js` |
| Push | Web Push VAPID (`@block65/webcrypto-web-push`), secrets `VAPID_PUBLIC_KEY/PRIVATE_KEY` |
| Testes | `node:test` + `tsx`, 40 suites, adaptador D1-sobre-SQLite próprio (`tests/helpers/d1.ts`) |
| Externas | Nominatim (geocode) + OSRM (rotas), com cache e rate limit próprios |

**Não existe hoje:** R2 (arquivos são BLOBs na tabela `files` do D1), middleware.ts, e-mail transacional, Asaas, qualquer gateway de pagamento, CI/CD visível.

## 2. Estrutura de pastas

```
src/app/            login, assinar/[token] (público), portal/** (portal do cliente),
                    diagnostico-pwa, (app)/ [23 módulos], api/ [8 grupos de rotas]
src/app/(app)/      agenda, aniversarios, busca, chat, clientes, compras, configuracoes,
                    contratos, dashboard, disponibilidade, erros, estoque, fidelidade,
                    financeiro, fretes, historico, notificacoes, operacao, orcamentos,
                    promocoes, recibos, relatorios, reservas
src/app/api/        arquivo, assinar, chat(+arquivo, unread), log-erro, logout,
                    portal(arquivo, documento), push, routes
src/lib/            ~60 módulos (auth, db, settings, queries, reservations, stock,
                    financeiro, recibos, contracts, portal-*, push-*, chat, fidelidade…)
src/components/     componentes compartilhados (Shell, SearchForm, ImageInput…)
migrations/         0001–0026 (versionadas, padrão wrangler d1 migrations)
scripts/            setup-push, smoke-pwa, smoke-disponibilidade, seed, splash
tests/              40 suítes + helpers/d1.ts
custom-worker.ts    fetch (OpenNext) + scheduled (crons com runWithDb)
```

## 3. Banco de dados

- D1 único, produção gerenciada via `wrangler d1 migrations apply limas-locacoes --remote`.
- Sem tabela de empresas; **todas as tabelas são globais** (single-tenant estrutural).
- `SCHEMA` também duplicado em `src/lib/db.ts` (usado por testes; precisará acompanhar as migrations).

## 4. Tabelas (~50)

**Núcleo:** users, sessions, settings (KV), categories, customers, products, product_units, product_components, reservations, reservation_items, quotes, quote_items, payments, deposits, expenses, expense_purposes, vehicles, freights, operations (+ views deliveries/pickups/assemblies/disassemblies), checklists, attachments, damage_reports, maintenance, contracts, notifications, audit_logs.

**Financeiro (0004+):** financial_accounts, suppliers, purchases, purchase_items, stock_movements, financial_entries.

**Uploads/assinatura/portal:** files (BLOB), contract_signatures, customer_documents, portal_sessions, receipts.

**Notificações/push (0006):** operational_roles, user_operational_roles, notification_preferences, notification_rules, activities, notification_events, user_notifications, push_subscriptions, push_deliveries, scheduler_state.

**Outros:** promotions, promotion_tiers, fidelity_events, fidelity_rewards, fidelity_messages, stock_revision, stock_write_guard (guardas de concorrência de estoque), chat_conversations, chat_participants, chat_messages, route_cache, api_rate_limits, error_logs.

## 5. Relacionamentos

- `customers 1—N reservations/quotes/freights/portal_sessions/customer_documents`; `reservations 1—N items/payments/deposits/contracts/operations/damage_reports/checklists( via operations)/financial_entries`.
- `products 1—N product_units/components/maintenance`; `reservation_items → products` (+ componentes para kits).
- `payments/deposits/financial_entries` interligados (conta corrente, quitaciones, recibos).
- `users 1—N sessions/push_subscriptions/notification_preferences/user_operational_roles`; `created_by` espalhado em documentos.
- FKs declaradas como `REFERENCES` (sem enforcement forte no D1 por padrão, mas consistentes no código).

## 6. Autenticação atual

- Sessão por cookie `limas_session` (httpOnly, sameSite=lax, secure em prod, 30 dias) + tabela `sessions`.
- Senhas com **scrypt + salt** e comparação `timingSafeEqual` — sólido.
- `currentUser()/requireUser()/requireAdmin()/assertAdmin()` em `src/lib/auth.ts`; páginas e server actions usam.
- CSRF: rotas de mutação em `/api/*` exigem `origin === url.origin` (`apiUser(request, mutate=true)`); server actions contam com a proteção nativa do Next.
- Portal do cliente: sessão separada (`limas_portal`, `portal_sessions`), login por CPF + senha, convites por token.
- **Lacunas:** login sem rate limit/lockout (o `rateLimit` existe mas não é usado no login), sem recuperação de senha, sem rotação/invalidação em massa de sessões, sem 2FA.

## 7. Sistema atual de usuários

- Papéis: **apenas `admin` | `operador`** (CHECK no banco). Sem propietário/financeiro/visualização.
- Usuários criados manualmente em Configurações (admin cria username/senha). Sem convite para equipe (só para clientes do portal).
- Papéis operacionais (`operational_roles`) servem apenas para rotear notificações/push por área (entrega, retirada…).
- `active` flag existe; usuário desativado não autentica e a sessão é destruída no próximo uso.

## 8. Funcionalidades existentes (a preservar)

1. Reservas com orçamentos, promoções, fidelidade, caução, parcelamento, conta corrente.
2. Estoque por unidades físicas, kits, manutenção, danos com baixa e guarda otimista de concorrência (`stock_revision`/`stock_write_guard`).
3. Operação do dia: entregas/retiradas/montagens/desmontagens, checklists, anexos, veículos, atrasos.
4. Fretes com rota real (Nominatim/OSRM), calculadora de frete configurável.
5. Financeiro duplo: Pagar (fornecedores/compras/adiantamentos/finalidades) e Receber (recebimentos, quitaciones) + contas.
6. Contratos com modelo editável, **assinatura digital pública** (`/assinar/[token]`) e assinatura da empresa.
7. Recibos (pagamento, adiantamento, caução, quitação; A4/não-fiscal, séries próprias).
8. Portal do cliente (login CPF, documentos, histórico, contratos assinados, convites).
9. Chat interno com anexos e não-lidas; notificações in-app + **web push** agendada por minuto.
10. Fidelidade (eventos, recompensas, expiração via cron), promoções, aniversários (cron diário).
11. Dashboard, agenda, disponibilidade/timeline, relatórios, histórico, busca global, erros (`/erros`).
12. PWA instalável (iPhone/Android/desktop) com diagnóstico próprio.

## 9. Integrações existentes

Nominatim/OSRM (rotas, com cache e rate limit em D1), Web Push VAPID. Nenhuma de cobrança. `VAPID_SUBJECT` aponta para e-mail pessoal (`uericlislima@gmail.com`) — trocar por e-mail do produto.

## 10. Configurações específicas da Lima’s

- `settings.company_name` default `"Lima's Locacoes"`; fallback `"Lima's Locacoes"` em `configuracoes/actions.ts`.
- Textos do portal: "Peça um novo link à Lima's", "Equipe Lima's", "CPF cadastrado na Lima's".
- Mensagem WhatsApp do cliente: "Aqui é da Lima's Locações" (`clientes/[id]/page.tsx`).
- Metadados PWA/layout: `manifest.ts` ("Lima's Fretes e Locações"), `app/layout.tsx` (title/applicationName/OG).
- Prefixo de numeração **`LIMA`** fixo em `stock-write.ts` (reservas) e menções à série em `recibos.ts`.
- Seed automático (`ensureSeed`) cria `admin/admin123` e `operador/operador123` + dados demo na primeira execução.
- Placeholders de busca "LIMA-001" em reservas/contratos/busca/Shell.

## 11. Dados hardcoded (além do nome)

- `wrangler.jsonc`: worker `limas-locacoes`, D1 `limas-locacoes`, `VAPID_SUBJECT` pessoal.
- Cookies `limas_session`/`limas_portal`, `globalThis.__limasTestDb`, User-Agent `LimasLocacoes/1.0 (+https://limas-locacoes...workers.dev)`.
- Prefixos de documento fixos (LIMA, FRT, ORC, CTR, CMP, RCB) e `nextNumber` global sem escopo de empresa.
- `limas-pulso` (keyframes CSS) — cosmético, inofensivo, renomear por higiene.

## 12. Pontos que impedem multiempresa

1. **Zero `company_id`** em qualquer tabela; toda consulta é global (`SELECT ... FROM reservations` etc., ~60 módulos em `src/lib` e ações/páginas).
2. `settings` é um KV global — logo, contrato, PIX, templates são "da instalação", não da empresa.
3. Numeração de documentos global (`nextNumber` sem escopo) — colidiria entre empresas.
4. `notifications` global (sem destinatário/empresa) — vazaríamos avisos entre empresas.
5. `audit_logs` e `error_logs` globais — sem escopo e sem separação plataforma/empresa.
6. `files` sem `company_id` e **`/api/arquivo/[id]` público sem autenticação** — qualquer id serve qualquer empresa.
7. Chat (`chat_conversations`) sem empresa; buscas e relatórios globais.
8. Guardas de estoque single-row (`CHECK(id=1)`) — por empresa precisam de escopo.
9. Cron (push, fidelidade, aniversários) itera tudo globalmente — precisará iterar empresas.
10. Seed automático de dados demo na inicialização — poluiria tenants reais.

## 13. Pontos que impedem comercialização

- Sem cadastro/onboarding de novas empresas (não há como uma empresa X se registrar).
- Sem planos, trial, assinatura, cobrança, inadimplência, cancelamento.
- Sem área administrativa da plataforma (`/admin`), sem landing page (`/` só redireciona).
- Banco/worker com nome da Lima’s; sem ambientes separados (staging) configurados.
- Credenciais default fracas criadas no boot; sem política de retenção/exclusão de dados.

## 14. Riscos de segurança

1. `/api/arquivo/[id]` **público**: expõe fotos de produtos, logo, assinaturas (empresa e clientes) sem login.
2. Login sem rate limit nem bloqueio por tentativas; sem aviso/fluxo de reset de senha.
3. Seed com `admin/admin123` em produção (se banco novo) — precisa de onboarding que force senha própria.
4. Papéis insuficientes para o produto (2 papéis); `financeiro`/`visualização` inexistentes.
5. Sem headers de segurança (CSP, X-Frame-Options, Referrer-Policy) nem middleware.
6. Upload valida MIME declarado pelo cliente (sem sniff de magic bytes no upload genérico).
7. `audit_logs` sem IP/UA; webhooks inexistentes (quando existirem, exigir token + idempotência).
8. Pontos positivos a preservar: scrypt+timingSafeEqual, cookies httpOnly/sameSite, origin-check em mutações API, rate limit D1 reutilizável, sanitização de HTML de contrato (`contract-html.ts`), listas fechadas de MIME e bloqueio de extensões perigosas no chat.

## 15. Estratégia recomendada de multi-tenancy

**Shared database / shared schema com `company_id`** (row-level isolation) — a que melhor se encaixa no D1 atual, sem mudar de banco:

- Tabela `companies` central; coluna `company_id INTEGER NOT NULL` em **todas** as tabelas de tenant (backfill = 1 para a Lima’s, migração de dados preservada).
- `settings` vira `company_settings` (chave por empresa) ou ganha `company_id` com PK composta — decisão na fase de modelagem.
- Contexto: `requireUser()` evolui para `requireCompanyContext()` → `{ user, company, role }`; **nenhum** `company_id` aceito do cliente — sempre derivado da sessão.
- Disciplina de SQL: toda query de tenant leva `company_id = ?` (revisão arquivo por arquivo + testes de cross-tenant obrigatórios).
- Tabelas **de plataforma** (sem company_id): plans, subscriptions (tem company_id), asaas_webhook_events, platform_settings, platform_users/admin, invitations de equipe.
- Numeração por empresa: prefixo passa a vir da empresa (config), sequência por `(company_id, prefixo)`.
- Cron: iterar empresas (loop por empresa com `runWithDb` inalterado).

## 16. Alterações necessárias no banco (rascunho de fases)

1. `companies` (+ `company_settings`), seed da empresa Lima’s e da Empresa Demonstração.
2. Backfill `company_id` em todas as tabelas de tenant (ADD COLUMN + UPDATE + índices `(company_id, …)`); NOT NULL via CHECK/rebuild conforme necessidade.
3. Platform: `plans`, `subscriptions`, `asaas_webhook_events`, `platform_settings`, convites de usuário (`user_invitations`), roles estendidos no `users` (+ `company_id` em users/sessions).
4. `audit_logs` + `company_id`, `ip`, `user_agent`; `notifications` + `company_id`; `files` + `company_id`; guardas de estoque por empresa.
5. Migração do `seed.ts` para fluxo de onboarding (sem auto-seed de produção).

## 17. Alterações necessárias no backend

- `auth.ts`: contexto de empresa + novos papéis; `login` com rate limit; reset de senha (arquitetura pronta, e-mail depois).
- Camada de dados: repassar `company_id` em todos os módulos de `src/lib` + actions + páginas + `queries.ts` (maior volume de trabalho do projeto).
- `settings.ts` → por empresa; `uploads.ts`/rotas de arquivo → autorização por empresa (token/sessão).
- Notificações, audit, error-logs, chat: escopo por empresa; cron por empresa.
- Novos serviços: `saas/companies` (onboarding), `saas/plans`, `saas/subscription`, `saas/asaas` (client server-only), `saas/webhooks`, `saas/platform-admin`.

## 18. Alterações necessárias no frontend

- Onboarding (criar conta → empresa → proprietário → trial → checklist inicial) e estados vazios orientados.
- Página `/assinatura` (plano, status, próxima cobrança, histórico, regularizar, cancelar).
- Área `/admin` da plataforma (empresas, assinaturas, MRR, eventos).
- Branding dinâmico pela empresa (layout, manifest, textos do portal, placeholders sem "LIMA-…").
- Landing pública do produto + login neutro.

## 19. Estratégia para Asaas

- Client server-only (`src/lib/saas/asaas.ts`) com base URL por `ASAAS_ENVIRONMENT` (sandbox: `https://api-sandbox.asaas.com`).
- Secrets: `ASAAS_API_KEY`, `ASAAS_ENVIRONMENT`, `ASAAS_WEBHOOK_TOKEN` (nunca no cliente, nunca em log).
- Fluxo: criar/localizar cliente → salvar `asaas_customer_id` → criar assinatura (PIX/cartão) → salvar `asaas_subscription_id` → status local dirigido por webhook.
- **Totalmente separado** do financeiro da locadora (item 49): assinatura nunca escreve em `payments/financial_entries`.

## 20. Estratégia de Webhooks

- `POST /api/webhooks/asaas` fora da auth de sessão; valida token do header; persiste em `asaas_webhook_events` (event_id único → idempotência), responde rápido, processa depois.
- Eventos mínimos: `PAYMENT_CREATED/RECEIVED/CONFIRMED/OVERDUE/REFUNDED/CANCELLED` (ou equivalentes reais do Asaas) + `SUBSCRIPTION_CREATED/UPDATED/DEACTIVATED` (nomes a confirmar na doc sandbox).
- Processamento determinístico (at-least-once): mesmo evento duas vezes não muda estado; falhas registram `error/attempts` para reprocesso.

## 21. Estratégia de trial

- `subscription_status = TRIAL`, `trial_started_at/trial_ends_at`; duração em configuração da plataforma (default 30 dias).
- Banner/aviso de dias restantes; bloqueio só no fim do trial (SUSPENDED read-only), nunca perda de dados.

## 22. Estratégia de inadimplência

- Webhook OVERDUE → `PAST_DUE` (aviso + tolerância configurável) → sem regularização → `SUSPENDED` (somente leitura) → pagamento → `ACTIVE`.
- Estados: TRIAL | ACTIVE | PAST_DUE | SUSPENDED | CANCELLED | EXPIRED. Nada é apagado.

## 23. Estratégia de usuários/permissões

- Papéis v1: `owner` (primeiro usuário do onboarding), `admin`, `operacional`, `financeiro`, `viewer` — matriz `módulo × ação` em código (mapa central) com checagem server-side; UI esconde o que não pode.
- Estrutura pronta para permissões granulares futuras (tabela/JSON de permissões por papel) sem refazer os papéis v1.
- Convite de equipe: registro pendente + link/token (mesma mecânica já existente no portal do cliente).

## 24. Estratégia de auditoria

- `audit_logs` + `company_id`, `ip`, `user_agent`; registrar auth, usuários/permissões, configurações, estoque, reservas, financeiro, assinatura e **acesso administrativo da plataforma** (com motivo).
- Sem segredos/PII sensível nos logs; tela `/erros` e histórico já dão a base de visualização.

## 25. Estratégia de staging/produção

- Wrangler environments (`env.staging`): D1 separado (banco `app-staging`), secrets próprios, mesmo pipeline `opennextjs-cloudflare`.
- Migrations sempre versionadas, aplicadas em staging antes de produção (`db:migrate:local → staging → produção`); nunca DDL manual.
- Backup: `wrangler d1 export` agendado (cron + R2 ou storage externo barato) + runbook de restore/rollback documentado.

## 26. O que pode ser mantido exatamente como está

- Arquitetura Next/OpenNext/Workers/D1, custom-worker e crons (estrutura).
- **Todo o domínio**: reservas, estoque/kits/guardas, operação, fretes/rotas, financeiro duplo, recibos, contratos/assinatura digital, portal do cliente, chat, push/notificações, fidelidade, promoções, aniversários, PWA.
- Infra de testes (adaptador D1/SQLite) e o padrão "core testável + camada de request" (`*-db.ts` / `*-auth.ts`).
- Componentes UI, Tailwind, utilitários (format, availability-time, contract-html).

## 27. O que precisa ser refatorado

1. Camada de dados inteira para escopo `company_id` (maior esforço; retroativo via testes cross-tenant).
2. `auth.ts` (contexto de empresa, papéis, rate limit no login) e `settings.ts` (por empresa).
3. Numeração de documentos; seed (vira onboarding); cron (multi-empresa).
4. `uploads.ts` + rotas de arquivo (autorização); notificações/audit/error-logs/chat (escopo).
5. Metadados PWA/branding/textos (empresa dinâmica) e remoção de tudo do item 10/11.

## 28. O que não deve ser implementado agora

Marketplace; apps nativos; domínios por cliente; white-label completo; multi-moeda/países; emissão fiscal; CRM; IA; múltiplos gateways; subcontas Asaas; microserviços. Também adiar: envio real de e-mail (preparar arquitetura apenas), reconciliação automática Asaas (webhook é o mecanismo principal), UI de permissões granulares (só papéis sólidos v1).

---

## Riscos de vazamento entre empresas (resumo executivo)

Com o código atual, **duas empresas no mesmo banco veriam tudo** (clientes, reservas, financeiro, contratos, chat, notificações) e arquivos seriam acessíveis publicamente por id. O isolamento só existirá após: (a) backfill de `company_id` + (b) revisão de todas as consultas + (c) testes automáticos cross-tenant (A não vê B, não edita, não exclui, não exporta; arquivos idem) — itens que serão critério de aceite de cada fase.

## Ordem de execução proposta (ajustada ao que foi encontrado)

Etapas 2–7 do plano do usuário seguem a sequência do briefing (modelagem → migrations → auth → perfis → isolamento → configurações). Destaques práticos:

- **Antes de tudo**, criar as migrations em banco local novo e preservar a Lima’s como empresa id 1 (dados reais intactos).
- Cada fase termina com testes (`npm test`) incluindo suítes novas de isolamento, e typecheck.
- Asaas só depois do isolamento e do onboarding (sandbox), webhooks por último do bloco de cobrança.

*Nenhum código foi modificado nesta etapa, conforme instruído.*
