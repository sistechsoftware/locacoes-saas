# Investigação — revogação e reemissão do contrato da reserva LIMA-064

Branch: `audit/revogacao-contrato-lima-064`
Data: 06/11/2026
Escopo: investigação apenas. Nenhum `INSERT`/`UPDATE`/`DELETE` foi executado; todas as
consultas ao banco de produção foram `SELECT` via `wrangler d1 execute --remote`.
Nada foi alterado em reserva, pagamentos, adiantamentos, estoque, contratos ou auditoria.

---

## 1. Diagnóstico do módulo de contratos

### 1.1 Vínculo contrato ↔ reserva

- Tabela `contracts` (migration `0001_initial.sql`, ampliada por `0021`, `0027`, `0015`):
  `reservation_id INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE`.
- O vínculo é **1 reserva : N contratos**. `reservations` nunca aponta para um contrato.
- `ensureContract()` (`src/lib/contracts.ts`) devolve o contrato existente da reserva
  **quando o status é diferente de `cancelado`**:

  ```sql
  SELECT id FROM contracts WHERE reservation_id = ? AND status <> 'cancelado'
  ORDER BY id DESC LIMIT 1
  ```

  Consequência direta: **um contrato com status `cancelado` libera a criação de um novo
  contrato para a mesma reserva**, com número novo. Essa é a base técnica de toda a solução.
- Status possíveis (`CHECK` da tabela): `pendente`, `enviado`, `assinado`, `encerrado`,
  `cancelado`. Não existe `substituido`, `revogado` nem coluna de versão em `contracts`.

### 1.2 Como os dados da empresa entram no contrato

- Fonte: `company_settings` (`company_name`, `company_doc`, `company_address`,
  `company_city`, `company_phone`, `company_signature_file_id`), lida por
  `getSettings()` / `settingsDaEmpresa()` (`src/lib/settings.ts`).
- `buildContractBody()` / `buildContractBodyDigital()` (`src/lib/contracts.ts`) resolvem os
  `{{placeholders}}` (`{{empresa}}`, `{{cnpj}}`, `{{endereco_empresa}}`…) **no momento da
  geração** e gravam o texto final em `contracts.body`.

### 1.3 Snapshot ou leitura dinâmica?

**Snapshot em texto, com dois congelamentos distintos:**

1. **Geração** (`ensureContract` → `buildContractBody`): o modelo de impressão é renderizado
   com os dados daquele instante e gravado em `contracts.body`.
2. **Primeira abertura do link pelo cliente** (`congelarCorpoAoAbrir`, `src/lib/assinatura-db.ts`):
   se `body_frozen_at IS NULL`, o corpo é **sobrescrito** pelo modelo digital renderizado
   (`buildContractBodyDigital`) e `body_frozen_at` recebe o carimbo. Daí em diante não muda.
3. **Assinatura** (`assinar`): `contract_signatures.body_snapshot` guarda o texto exato lido,
   mais `document_hash` (SHA-256 de corpo + nome + data + arquivo da assinatura).

Os dados da empresa **não são relidos** ao abrir/visualizar um contrato antigo. Mas o
**cabeçalho** das páginas (`CabecalhoContrato`, `src/app/(app)/contratos/[id]/page.tsx` e
`src/app/assinar/[token]/page.tsx`) lê a configuração **atual** — ou seja, hoje um contrato
antigo imprime nome/CNPJ novos sobre um corpo com nome/CNPJ antigos. É exatamente a
inconsistência que motiva esta pendência.

### 1.4 Fluxo de assinatura eletrônica

- Link público `/assinar/[token]` (fora do grupo autenticado).
- Token de 32 caracteres, ~180 bits (`src/lib/assinatura.ts`); no banco fica **apenas o
  SHA-256** (`contract_signatures.token_hash`, `UNIQUE`).
- Validade padrão `signature_link_days` (7 dias), `expires_at` gravado no momento da emissão.
- `gerarLink()` revoga automaticamente qualquer link `pendente` anterior do mesmo contrato:
  **só o link mais recente vale**.
- `impedimento()` bloqueia link `assinado`, `revogado` ou `expirado`.
- `assinar()` grava, numa única trava otimista (`WHERE status='pendente'`): `body_snapshot`,
  `signer_name`, `signature_file_id` (PNG em `files`), `document_hash`, `accepted_at`,
  `signed_at`, IP, user-agent; marca `contracts.status='assinado'` e insere em
  `customer_documents` (`source='assinatura_virtual'`) como registro próprio.
- `revogarLinkAssinatura` / `revogarLink()` revogam **somente o link**, não o contrato.
- Assinatura da empresa: flag `company_signature_included` (1 = existia assinatura cadastrada
  no ato). A **imagem** exibida, porém, vem de `getCompanySignature()` em tempo real
  (ver risco R5).

### 1.5 Mecanismos de cancelamento, revogação, exclusão ou substituição

| Mecanismo | Existe? | Onde |
|---|---|---|
| Revogar link de assinatura | Sim | `revogarLink` (`src/lib/assinatura-db.ts`), `revogarLinkAssinatura` (`contratos/actions.ts`) |
| Cancelar contrato (status) | Sim, manual | `setContractStatus` — aceita `cancelado` sem validação |
| Excluir contrato | **Não há UI nem action** | só `seed.ts` apaga (`DELETE FROM contracts WHERE reservation_id = ?`) |
| Substituir / versionar contrato | **Não existe** | sem coluna de versão, sem vínculo “substitui / substituído por” |
| Regerar texto | Sim, bloqueado se `assinado` | `regenerateContract` |
| Editar texto manualmente | Sim, **sem bloqueio para assinado** | `saveContractBody` (apenas admin) |

### 1.6 Impacto de excluir um contrato

Chaves estrangeiras que apontam para `contracts`:

- `contract_signatures.contract_id` → `ON DELETE CASCADE`: **apaga a assinatura**, o
  `body_snapshot`, o `document_hash`, o IP/user-agent e o vínculo com o PNG assinado.
- `customer_documents.contract_id` → `ON DELETE SET NULL`: o registro do histórico do cliente
  permanece, mas perde o contrato e (via `signature_id SET NULL`) a assinatura.
- Nada em `payments`, `deposits`, `financial_entries`, `reservation_items`, `reservations`,
  `products` referencia `contracts`. Excluir contrato **não** mexe em valores, caixa,
  adiantamentos, caução, estoque ou disponibilidade.
- O caminho inverso é que apaga contratos: `contracts.reservation_id ON DELETE CASCADE`
  (excluir a reserva apaga os contratos).

Ou seja: excluir é “seguro” financeiramente e **destrutivo** juridicamente — some a prova do
que foi lido e assinado.

### 1.7 Histórico e auditoria

- `audit_logs` registra `criar`, `editar` (link gerado / texto editado / regerado) e `status`,
  com autor, IP e user-agent. **Não guarda o corpo anterior** (sem diff).
- `customer_documents` é o histórico documental do cliente; cada assinatura cria uma linha.
- `contract_signatures.version` existe (default 1), mas **nunca é incrementado** — não há
  versionamento real. Não há coluna de versão em `contracts`.
- Não há precedente de contrato cancelado na base: **0 cancelados em 66 contratos**
  (último número: `CTR-068`).

---

## 2. Situação exata da reserva LIMA-064

Reserva (somente leitura):

| Campo | Valor |
|---|---|
| `reservations.id` | 83 |
| `number` | LIMA-064 |
| `status` | confirmada |
| `company_id` | 1 |
| `customer_id` | 95 |
| `event_date` | 31/12/2026 |
| `total_cents` | 24.200 (R$ 242,00) |
| `discount_cents` | 0 |
| Itens | 3 |
| Pagamentos | 1 registro, R$ 72,60 pagos |
| Caução | 1 registro |
| Lançamentos financeiros | 0 |

Contrato vinculado — **um único**:

| Campo | Valor |
|---|---|
| `contracts.id` | 74 |
| `number` | CTR-063 |
| `status` | **assinado** |
| `reservation_id` | 83 |
| `company_id` | 1 |
| Criado | 04/11/2026 12:11:07 (UTC) — 09:11 no horário de Brasília, por Uériclis Lima |
| `sent_at` | 04/11/2026 09:11 |
| `body_frozen_at` | 04/11/2026 09:11 (corpo digital congelado na primeira abertura) |
| `signed_at` | 04/11/2026 09:17 |
| `signer_name` | Roseni Araújo |
| `company_signature_included` | 1 |
| `body` | 4.966 caracteres |

Assinatura digital:

| Campo | Valor |
|---|---|
| `contract_signatures.id` | 82 |
| `status` | assinado |
| `version` | 1 |
| `accepted_at` / `signed_at` | 04/11/2026 09:17 |
| `expires_at` | 11/11/2026 23:59:59 |
| `revoked_at` | null |
| `document_hash` | `58ef435bef885af030c8f82f72099ed7d8c79853bdc28f91dfcc1edc799ab82f` |
| `signature_file_id` | `8d05e0f0342e4e66981cd91d2708c6c7` (arquivo existe em `files`) |

Histórico documental: `customer_documents.id = 49` — “Contrato CTR-063 assinado”,
`source='assinatura_virtual'`, `signature_id=82`.

### Divergência confirmada

Dentro do corpo congelado do CTR-063:

> LOCADORA: **Lima’s Locações**, CNPJ 40.226.211/0001-61, endereço Rua Cincerro, 525(estoque),
> telefone (34) 98863-0010.

Cadastro atual (`company_settings`, empresa 1):

> `company_name` = **Locações para Festas Udi** — mesmo CNPJ, mesmo endereço, mesmo telefone.

Auditoria de configuração mostra “atualizou os dados da empresa” em 29/10, 05/11 19:57 e
06/11 14:54 — a última alteração é **posterior** à assinatura (04/11). Por isso o documento
assinado carrega o nome antigo.

### Respostas objetivas

1. **Contrato vinculado:** CTR-063 (`id 74`), único da reserva.
2. **Status:** `assinado`.
3. **Já assinado pela cliente:** sim, 04/11/2026 09:17, por Roseni Araújo.
4. **Registro de envio/visualização/assinatura:** sim — `sent_at`, `body_frozen_at` (abertura
   do link), `accepted_at`, `signed_at`, IP/UA, hash SHA-256, PNG da assinatura e linha no
   histórico documental.
5. **Invalidar sem comprometer histórico:** sim, por **cancelamento lógico com linhagem**
   (sem `DELETE`). O que não pode é apagar: `DELETE` derruba a assinatura em cascata.
6. **Gerar nova versão com dados atuais:** sim — basta o contrato antigo sair do estado
   “vigente” (`cancelado`), porque `ensureContract` já ignora cancelados e emite número novo
   (o próximo será `CTR-069`) com os `company_settings` atuais.

---

## 3. Possibilidade técnica de revogação / exclusão / substituição

| Alternativa | Viável? | O que acontece | Veredito |
|---|---|---|---|
| **A. Excluir o contrato** (`DELETE`) | Tecnicamente sim | Cascade apaga `contract_signatures` (snapshot, hash, IP, vínculo do PNG); `customer_documents` fica órfão da assinatura; página do documento assinado passa a 404; a reserva e o financeiro não mudam | **Não recomendado** — destrói prova de assinatura |
| **B. Só cancelar o contrato** (`status='cancelado'`) | Sim, sem código novo | Some do “vigente”; a assinatura continua `assinado`; portal continua exibindo o documento como assinado; reserva fica sem contrato novo | Insuficiente |
| **C. Cancelar + gerar novo contrato** | Sim, com o código atual e 2 ações manuais | `ensureContract` cria `CTR-069` com dados atuais e novo link; porém nada liga os dois documentos, e a assinatura antiga continua “assinado” e listada como tal no portal | Melhora, mas gera ambiguidade |
| **D. Substituição com linhagem** (recomendada) | Sim, exige migration + action | Cancela o antigo com motivo/autor/data, revoga links pendentes, cria o novo, grava `substituido_por` / `substitui`, marca visualmente o documento antigo como substituído e mantém tudo auditável | **Recomendado** |

Observação técnica: o `CHECK` de `contracts.status` **não permite** um valor novo
(`substituido`, `revogado`) sem reconstruir a tabela no D1. A solução recomendada mantém
`status='cancelado'` e expressa a substituição em colunas próprias + rótulo derivado na UI.

---

## 4. Riscos de cada alternativa

| # | Risco | A | B | C | D |
|---|---|---|---|---|---|
| R1 | Perda definitiva do snapshot/hash/IP da assinatura | **Alto** | nulo | nulo | nulo |
| R2 | Reserva ficar sem contrato vigente | baixo | **Alto** | nulo | nulo |
| R3 | Cliente/portal tratar o documento antigo como atual | **Alto** (registro some, mas documento também) | **Alto** | **Alto** | baixo (rótulo “substituído”) |
| R4 | Dois links válidos ao mesmo tempo | nulo | nulo | baixo | nulo (`gerarLink` já revoga pendentes) |
| R5 | Assinatura da empresa em documento histórico mudar sozinha | alto | alto | alto | médio — corrigir junto (ver 6.3) |
| R6 | Valores/pagamentos/adiantamentos/caução alterados | nulo | nulo | nulo | nulo (nenhuma FK financeira) |
| R7 | Estoque/disponibilidade afetados | nulo | nulo | nulo | nulo |
| R8 | Ambiguidade sobre qual documento é o vigente | alto | alto | **médio** | baixo (linhagem explícita) |
| R9 | Contrato assinado ser editado/regerado por engano | — | — | — | mitigado por guardas novas |
| R10 | Numeração/sequência global (`CTR-`) quebrar | nulo | nulo | baixo | baixo (`nextNumber` + `UNIQUE`) |

Riscos já existentes que a implementação deve fechar:

- **`saveContractBody` não bloqueia contrato assinado** (`src/app/(app)/contratos/actions.ts`):
  um admin pode alterar `contracts.body` de um contrato já assinado. O PDF assinado continua
  íntegro (lê `body_snapshot`), mas a tela do contrato passa a divergir do documento aceito.
- **`setContractStatus` aceita qualquer status**, inclusive `assinado` manual, sem tocar em
  `contract_signatures` — permite “assinado” sem lastro digital.
- **Assinatura da empresa não é congelada**: `assinar()` grava apenas o booleano
  `company_signature_included`; a imagem vem de `getCompanySignature()` (settings atuais) e o
  arquivo anterior é apagado em `salvarAssinaturaEmpresa`. Um documento assinado ontem pode
  exibir hoje outra assinatura da locadora (ou imagem quebrada).
- **Portal lista todo contrato assinado como vigente** (`contratosDoCliente`,
  `src/app/portal/(area)/contratos/page.tsx`): depois da substituição, o antigo continuaria
  na seção “Assinados digitalmente” sem qualquer aviso.
- **`RESERVATION_SELECT.contract_status`** e `notifications.ts` usam o contrato de maior `id`;
  após a substituição o novo é o mais recente — comportamento correto por acidente, mas
  convém filtrar `status <> 'cancelado'` explicitamente.

---

## 5. Solução recomendada

**Substituição lógica com linhagem e histórico preservado** (alternativa D), em três pilares:

1. **Nada é apagado.** O CTR-063 permanece com `body`, `body_frozen_at`, `signed_at`,
   `contract_signatures` (snapshot, hash, IP, PNG) e `customer_documents`.
2. **Revogação explícita.** CTR-063 vira `status='cancelado'` + `revoked_at`, `revoked_reason`,
   `revoked_by`; links pendentes são revogados. A assinatura **não** é apagada nem reescrita —
   ela continua sendo o que a cliente aceitou, agora marcada como **substituída**.
3. **Linhagem bidirecional.** CTR-063 recebe `superseded_by_id = <novo>`; o novo recebe
   `replaces_id = 74`. A reserva LIMA-064 passa a ter como vigente o contrato novo
   (`CTR-069`), gerado com os `company_settings` atuais e com link novo.

Critérios de aceite do comportamento desejado:

| Requisito pedido | Como fica |
|---|---|
| Invalidar o contrato anterior como vigente | `cancelado` + `superseded_by_id` |
| Preservar histórico/auditoria | nada excluído; `audit_logs` com motivo/autor; snapshot e hash intactos |
| Manter reserva, itens, valores, pagamentos, caução, datas | nenhuma escrita fora de `contracts`/`contract_signatures` |
| Gerar novo contrato da mesma reserva | `ensureContract` (ignora cancelados) |
| Usar dados empresariais atuais | `buildContractBody*` lê `company_settings` no ato |
| Novo link de assinatura | `gerarLink` (token novo, hash novo) |
| Não confundir assinatura antiga com a nova | banner “documento substituído” + linhagem + assinatura antiga fora de “vigente” |
| Identificar claramente o vigente | `contracts.status <> 'cancelado'` mais recente; selo “Vigente” / “Substituído por CTR-0xx” |

---

## 6. Arquivos, componentes, rotas, serviços e tabelas envolvidos

### 6.1 Banco (migration nova `0051_...`)

- `contracts`: `revoked_at TEXT`, `revoked_reason TEXT`, `revoked_by INTEGER`,
  `superseded_by_id INTEGER REFERENCES contracts(id)`, `replaces_id INTEGER REFERENCES contracts(id)`.
- `contract_signatures`: `company_signature_file_id TEXT` (congelar a imagem da locadora).
- Índices: `contracts(superseded_by_id)`, `contracts(replaces_id)`.
- `contract_signatures`: `version` passa a ser incrementado quando houver mais de uma
  assinatura no mesmo contrato (hoje sempre 1).

### 6.2 Código

- `src/lib/contracts.ts` — `ensureContract` (novo contrato), `buildContractBody*` (dados atuais);
  nova função `substituirContrato()` (transacional: revogar antigo → criar novo → linhagem → log).
- `src/lib/assinatura-db.ts` — `gerarLink` (revoga pendentes), `assinaturasDoContrato`,
  `documentoAssinado`, `assinar` (congelar `company_signature_file_id`).
- `src/lib/assinatura.ts` — estados/impedimentos (sem mudança de contrato; só link).
- `src/lib/domain.ts` — `CONTRACT_STATUS` (rótulo derivado “Substituído”) e helper de vigência.
- `src/app/(app)/contratos/actions.ts` — nova action `substituirContrato`; guardas em
  `setContractStatus`, `saveContractBody`, `regenerateContract`.
- `src/app/(app)/contratos/[id]/page.tsx` — aviso de substituído, link para o substituto,
  botão “Substituir contrato” (com confirmação e motivo).
- `src/app/(app)/contratos/assinado/[id]/page.tsx` — faixa “documento substituído por …”,
  usando o `company_signature_file_id` congelado.
- `src/app/(app)/reservas/[id]/page.tsx` — lista de contratos com selo Vigente/Substituído.
- `src/app/(app)/contratos/page.tsx` — filtro/aba e selo de substituído.
- `src/app/(portal/(area)/contratos/page.tsx` e
  `src/app/(portal/(area)/contratos/assinado/[id]/page.tsx` — separar vigente de histórico.
- `src/lib/portal.ts` — `contratosDoCliente` (marcar substituído/vigente).
- `src/lib/reservations.ts` — `contract_status` filtrar `status <> 'cancelado'`.
- `src/lib/audit.ts` — `logAction` com motivo da substituição.
- `src/lib/queries.ts`, `src/lib/notifications.ts` — não alertar contrato de reserva que já
  tem contrato vigente assinado.

### 6.3 Rotas

- `/contratos/[id]` (interna), `/contratos/assinado/[id]` (interna),
  `/assinar/[token]` (pública), `/portal/contratos`, `/portal/contratos/assinado/[id]`,
  `/reservas/[id]`.
- Server actions: `generateContract`, `regenerateContract`, `setContractStatus`,
  `saveContractBody`, `gerarLinkAssinatura`, `revogarLinkAssinatura` e a nova
  `substituirContrato`.

### 6.4 Testes existentes a estender

`tests/assinatura-integracao.test.ts`, `tests/assinatura-empresa.test.ts`,
`tests/modelos-contrato.test.ts`, `tests/contrato-adiantamento.test.ts`,
`tests/leitura-multi-tenant.test.ts`, `tests/portal-integracao.test.ts`
(helpers em `tests/helpers/d1.ts`).

---

## 7. Plano de implementação (branch nova, sem tocar em produção)

Branch sugerida: `feat/substituicao-contrato` (a partir da `main`).

1. **Migration `0051_substituicao_contrato.sql`** — colunas e índices do item 6.1, todas
   `ALTER TABLE ... ADD COLUMN` (compatíveis com D1, sem reconstruir tabela). Testar em
   `--local` e em `staging`.
2. **Domínio** — `substituirContrato({ contractId, motivo, user })` em `src/lib/contracts.ts`:
   validar empresa do contrato; recusar contrato já substituído/cancelado; revogar links
   `pendente`; marcar antigo `cancelado` + `revoked_*`; criar novo via `ensureContract`; gravar
   `superseded_by_id`/`replaces_id`; `logAction` com motivo. Nenhuma escrita em reserva,
   pagamentos, caução, estoque ou `customer_documents`.
3. **Action + UI** — `substituirContrato` em `contratos/actions.ts` (`requireModuleEdit`,
   confirmação com motivo obrigatório); botões e selos nas telas internas e do portal.
4. **Guardas** — bloquear `saveContractBody`, `regenerateContract`, `setContractStatus` e
   `gerarLinkAssinatura` em contrato `cancelado`/substituído; bloquear edição de corpo de
   contrato assinado.
5. **Integridade histórica** — congelar `company_signature_file_id` na assinatura e renderizar
   a imagem congelada no documento assinado (interno e portal).
6. **Portal e vigência** — vigente = contrato não cancelado mais recente; histórico mostra o
   substituído com faixa e link para o novo; `contract_status` da reserva ignora cancelados.
7. **Testes** — integração em D1 local: substituição preserva reserva/itens/pagamentos/caução;
   assinatura antiga continua legível com hash e snapshot; link antigo não assina; novo link
   assina; linhagem e auditoria gravadas; isolamento por `company_id`; tentativa em contrato
   de outra empresa = 404/redirect.
8. **Verificação** — `npx tsc --noEmit`, `npm test`, `npm run build` verdes; smoke em staging
   com uma reserva de teste; só depois, com autorização explícita, executar a substituição do
   CTR-063 em produção (idealmente precedida de `npm run db:backup:production`).

### Execução pontual da LIMA-064 (após autorização)

1. Conferir que os dados atuais da empresa estão corretos (já estão: “Locações para Festas Udi”).
2. Substituir o CTR-063 informando o motivo (ex.: “dados cadastrais da locadora atualizados”).
3. Resultado esperado: CTR-063 `cancelado` + substituído; **CTR-069** vigente, com dados
   atuais; novo token; reserva 83, 3 itens, R$ 242,00, R$ 72,60 pagos e caução inalterados.
4. Enviar o novo link à cliente; a assinatura anterior permanece arquivada como versão
   substituída, com hash e PNG originais.

---

## Anexo — evidências (somente leitura)

- `reservations` id 83 / LIMA-064 / confirmada / 2026-12-31 / 24.200 / empresa 1.
- `contracts` id 74 / CTR-063 / assinado / 04-11-2026 09:17 / `body_frozen_at` 09:11.
- `contract_signatures` id 82 / assinado / hash `58ef435b…` / PNG `8d05e0f0…`.
- `customer_documents` id 49 / “Contrato CTR-063 assinado”.
- `company_settings` empresa 1: `company_name` = “Locações para Festas Udi” (atual) vs corpo
  congelado “Lima’s Locações”.
- `audit_logs`: criação do contrato (1802), geração do link (1803), alteração de dados da
  empresa em 05/11 19:57 e 06/11 14:54.
- Base: 66 contratos, 0 cancelados, último `CTR-068`.
