# RUNBOOK — Backup e Recuperação do D1 (Pendência #09)

**Escopo:** D1 de produção (`limas-saas-db`) e de staging (`limas-saas-staging-db`).
**Nunca** rode restore em produção sem a confirmação digitada descrita em §6.
Este runbook é a fonte verdadeira para RPO/RTO, rotina diária, restore e rollback.

---

## 1. Componentes

| Peça | Onde | Comando |
|---|---|---|
| Backup (export + SHA-256 + R2) | `scripts/db-backup.mjs` | `npm run db:backup:production` / `db:backup:staging` |
| Restore (gate + verificação) | `scripts/db-restore.mjs` | `npm run db:restore:staging` / `db:restore:production` |
| Migration com backup obrigatório | `scripts/db-migrate.mjs` | `npm run db:migrate` (é este que roda as migrations de produção) |
| Agendamento diário | `.github/workflows/backup-d1.yml` | todo dia 03:00 UTC + manual (`workflow_dispatch`) |
| Armazenamento externo | R2 `limas-saas-backups`, prefixo `d1/` | lifecycle: expira após **90 dias** (regra `expirar-backups-antigos`) |
| Retenção local | `backups/` (gitignored) | poda automática após **30 dias** (flag `--manter-dias`) |
| Auditoria | `backups/manifesto.log` | 1 linha por backup: data, ambiente, bytes, SHA-256, destino R2 |

Artefatos por execução: `backups/<prod|staging>-<AAAA-MM-DD-HHMMSS>[-<rotulo>].sql`
+ `.sha256` ao lado. O mesmo arquivo é enviado para `r2://limas-saas-backups/d1/`.

## 2. RPO e RTO

| Métrica | Valor | Base |
|---|---|---|
| **RPO — migrations de produção** | **≈ 0** | `npm run db:migrate` só executa depois de um backup bem-sucedido; se o backup falhar, a migration **não roda** (verificado em 2026-10-09: falha de API → abort). |
| **RPO — dados (rotina)** | **24 h** | backup diário 03:00 UTC (00:00 horário de Brasília). |
| **RPO — dados (máximo absoluto)** | 24 h — ou até 30 dias via *Time Travel* do D1, o que ocorrer primeiro | Time Travel é complemento automático do D1; este runbook cobre o caso em que ele não basta (dump externo). |
| **RTO** | **medido: ~2–3 min** para staging (export prévio + restore de 806 statements + verificação de 70 tabelas/433 linhas) | produção é mesma ordem de grandeza (90 KB de dump); reserve **30 min** com folga para diagnóstico e conferências. |

## 3. Setup (uma vez)

1. **Bucket R2**: já existe `limas-saas-backups` (o script cria automaticamente se faltar).
   Lifecycle já aplicado: `wrangler r2 bucket lifecycle add limas-saas-backups expirar-backups-antigos d1/ --expire-days 90 -y`
2. **GitHub Actions** (para o agendamento diário) — passo manual, requer permissão de admin:
   - `Settings → Secrets → Actions`:
     - `CLOUDFLARE_API_TOKEN` — token da API com permissão **D1:Edit** e **Workers R2:Edit** (escopo mínimo);
     - `CLOUDFLARE_ACCOUNT_ID` — id da conta (`b6a8322542c3dc9a7c706fe457734530`).
   - Sem esses secrets o workflow falha alto de propósito — silêncio é pior que falha.
3. **Cron local alternativo** (se o GitHub Actions não for usado):
   - Linux/macOS: `0 3 * * * cd /caminho/locacoes-saas && npm run db:backup:production >> backups/cron.log 2>&1`
   - Windows: `schtasks /create /tn "backup-d1" /sc daily /st 00:00 /tr "cmd /c cd C:\caminho\locacoes-saas && npm run db:backup:production >> backups\cron.log 2>&1"`
4. **Node ≥ 22** no ambiente que roda restore (o gate usa `node:sqlite`).

## 4. Rotina diária (backup)

```bash
npm run db:backup:production   # exporta produção → conferência → SHA-256 → R2
npm run db:backup:staging      # idem staging
```

- Sai com código ≠ 0 se **qualquer** etapa falhar (o agendador precisa ver a falha).
- Sobe para o R2 também o `.sha256`; conferência posterior: `sha256sum -c`.
- Flags úteis: `--sem-r2` (só local), `--manter-dias N` (retenção local), `--rotulo x` (ex.: `pre-migrate`).
- **Confiança semanal recomendada:** `ls -la backups/` + conferir `manifesto.log` e o
  último objeto em `wrangler r2 object get limas-saas-backups/d1/<arquivo> --file /tmp/x.sql`.

## 5. Backup obrigatório antes de migration de produção

```bash
npm run db:migrate    # NÃO é mais "wrangler d1 migrations apply" direto
```

Fluxo interno (`scripts/db-migrate.mjs`):
1. `db-backup.mjs production --rotulo pre-migrate` → falhou? **Aborta** (banco intacto);
2. `wrangler d1 migrations apply limas-saas-db --remote --env production`;
3. Se a migration falhar, imprime o caminho de rollback (§7).

**Não existe flag para pular o backup.** Se o backup falhar, corrija o backup — nunca
migre sem ponto de restauração. Mantenha `backups/prod-*-pre-migrate.sql` pelo menos
até a próxima migration passar em produção.

## 6. Restore

### 6.1 Restore em staging (testado — pode rodar sempre que precisar)

```bash
# 1. backup do estado atual (rollback point) — o script faz sozinho
# 2. restore com gate e verificação
npm run db:restore:staging -- --arquivo backups/staging-<data>.sql --sim
# 3. migrations sobre o banco restaurado (deve dizer "No migrations to apply")
npm run db:migrate:staging
```

O que o script faz, nesta ordem:
1. confere o `.sha256` do dump;
2. monta o arquivo final (drops topológicos → schema primeiro → dados reordenados
   **por linha** a partir dos valores de FK → statements >90 KB quebrados em blocos);
3. **GATE**: simula o arquivo inteiro em SQLite em memória, com foreign_keys=ON —
   se reprovar, aborta **sem tocar no banco alvo**;
4. backup prévio do alvo (rollback point, sobe para o R2);
5. executa em um único `wrangler d1 execute --file` (em falha o D1 rollbacka
   sozinho para o último estado bom);
6. verifica: tabelas + contagem de linhas por tabela contra o dump; `integrity_check`
   quando o D1 permite (hoje devolve `SQLITE_AUTH` — a contagem faz as vezes).

### 6.2 Restore em produção (só em incidente real)

```bash
npm run db:restore:production -- --arquivo backups/prod-<data>.sql
```

Guardas que **não** podem ser contornadas:
- exige terminal interativo (não roda via CI/script);
- exige digitar exatamente `RESTAURAR PRODUCAO`;
- backup prévio do alvo é obrigatório (rollback point);
- antes de rodar: comunicar os clientes afetados e anotar a hora do incidente.

Passo a passo de incidente:
1. Identifique o dump correto: `cat backups/manifesto.log` (data/hora, SHA-256);
2. Rode o comando acima; confira o ✔ final de verificação;
3. Rode `npm run db:migrate` (aplica migrations pendentes — pode ser no-op);
4. Smoke test da aplicação (login, listagens, cobrança);
5. Guarde o `backups/prod-*-pre-restore.sql` (estado anterior ao incidente).

## 7. Rollback de migration (estratégia de reversão)

As migrations do projeto **não têm script de down** — a reversão é assim, nesta ordem
de preferência:

1. **Forward-fix (preferencial):** nova migration corrigindo o que a anterior quebrou.
   É o caminho padrão: mantém `d1_migrations` coerente e não perde dados.
2. **Time Travel do D1 (até 30 dias):** `wrangler d1 time-travel restore <db> --bookmark <bookmark>`
   (ou `--timestamp <RFC3339>` para achar o ponto) — restaura o estado do banco num
   ponto no tempo, sem SQL. Use para corrupção recente; confirme o bookmark ANTES
   (é irreversível a partir do ponto escolhido).
3. **Restore do dump (último recurso):** §6.2. Só quando 1 e 2 não servem (dump mais
   antigo que o incidente, ou export externo). **Atenção:** isto descarta TUDO que
   aconteceu depois do dump — é perda de dados por definição; RPO = idade do dump.

Antes de qualquer uma das três: `npm run db:backup:production` (ponto atual, mesmo
para investigação).

## 8. Retenção

| Onde | Regra | Como foi aplicado |
|---|---|---|
| R2 (`limas-saas-backups/d1/`) | **90 dias** (mínimo exigido: 30) | lifecycle `expirar-backups-antigos` — `wrangler r2 bucket lifecycle list limas-saas-backups` |
| Local (`backups/`) | 30 dias | poda automática no próprio `db-backup.mjs` |
| Manifesto local | indeterminado (linhas de texto) | `backups/manifesto.log` |

Os dumps contêm dados de clientes (senhas com hash, anexos): `backups/` está no
`.gitignore` — **nunca commitar**, nunca anexar em issue/PR.

## 9. Armadilhas conhecidas do D1 (medidas em 2026-10-09)

O restore não é "mandar o dump cru" — estas foram as causas reais de falha e estão
todas tratadas em `scripts/db-restore.mjs`:

1. **`SQLITE_TOOBIG`** — statements >~100 KB são rejeitados (o dump tem um `files.data`
   de 264 KB) e o wrangler só mostra `{"D1_RESET_DO":true}`, sem dizer onde foi.
   Tratado: quebra em INSERT + UPDATEs de 40 KB.
2. **`||` derruba BLOB não-UTF8** — concatenar blobs por `||` no D1 converte para
   texto e perde bytes (8 → 4 no teste). Tratado: montar hex em texto e `unhex()` final.
3. **Foreign key imediata** — o import remoto não honra `PRAGMA foreign_keys=OFF` de
   forma confiável e o dump intercala schema/dados na ordem de criação (há FK para
   frente e ciclo users↔companies). Tratado: drops topológicos, schema primeiro,
   dados reordenados **por linha** via valores de FK + gate de simulação.
4. **`PRAGMA integrity_check`** devolve `SQLITE_AUTH` no D1 (local e remoto).
   Tratado: verificação por contagem de tabelas/linhas contra o dump.
5. **Tabelas internas** `_cf_METADATA`/`sqlite_*` — fora de inventário/drop
   (`COUNT(*)` nelas também dá `SQLITE_AUTH`).
6. **Rollback automático** — quando o import remoto falha, o D1 volta ao último
   estado bom; um restore falho **não** deixa o banco pela metade.

## 10. Registro de testes (2026-10-09)

| Teste | Resultado |
|---|---|
| Round-trip local: `db:backup --local` → `db:restore --local` | ✔ 70 tabelas / 141 linhas conferidas |
| **Restore remoto em staging** (`db:restore:staging` sobre dump real) | ✔ 806 statements; 70 tabelas / 433 linhas conferidas |
| Integridade do blob gigante pós-restore (132.084 bytes, início/fim) | ✔ byte a byte |
| `npm run db:migrate:staging` sobre banco restaurado | ✔ `No migrations to apply!` |
| `npm run db:backup:production` (export + SHA-256 + R2) | ✔ 90 KB / 179 linhas |
| Gate do `npm run db:migrate` com falha de backup simulada | ✔ abortou, banco intacto |
| `npm run db:migrate` completo (backup → no-op apply) | ✔ exit 0 |
| Lifecycle R2 90 dias | ✔ `wrangler r2 bucket lifecycle list` |

Repetir ao menos a linha "Restore remoto em staging" **trimestralmente** (é o teste
que prova que o RTO/RPO valem alguma coisa).

## 11. Pendências manuais

- [ ] Criar os secrets `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID` no GitHub
      Actions (§3.2) — até lá o backup diário só roda por cron local/manual.
- [ ] Definir para onde o workflow deve alertar em falha (e-mail/Slack) — o job já
      falha alto, falta o canal de aviso.
