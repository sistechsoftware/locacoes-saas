import { getCloudflareContext } from "@opennextjs/cloudflare";
import { marcarConsulta, novaMemoriaAsync, type MemoriaAsync } from "./perf";

type Row = Record<string, any>;

declare global {
  // eslint-disable-next-line no-var
  var __limasTestDb: D1Database | undefined;
  /** Empresa padrao do banco (rotinas de plataforma/testes; producao usa sessao). */
  // eslint-disable-next-line no-var
  var __limasDefaultCompany: number | undefined;
  /** ALS da binding do banco, compartilhada entre os DOIS bundles do OpenNext. */
  // eslint-disable-next-line no-var
  var __limasDbAls: MemoriaAsync<D1Database> | undefined;
}

/**
 * ALS da binding do banco, compartilhada entre os DOIS bundles gerados pelo
 * OpenNext (mesmo truque do alsLote, mais abaixo): sem uma instancia unica, o
 * contexto criado num bundle nao sobreviveria ao import duplicado. A fabrica
 * mora em perf.ts para o build nao gerar aviso novo de Edge Runtime.
 *
 * POR QUE ALS E NAO UMA VARIAVEL DE MODULO: o `scheduled()` do Worker dispara
 * VARIAS rotinas CONCORRENTES (notificacoes, fidelidade, aniversarios, e-mails,
 * billing) e cada uma delas chama runWithDb(env.DB, ...). Com a variavel antiga,
 * cada chamada guardava `anterior` e restaurava no `finally` — a PRIMEIRA a
 * terminar restaurava `undefined` no meio das que continuavam rodando, e getDb()
 * caia em getCloudflareContext(), que LANCA fora de request (`getCloudflareContext
 * has been called without having called initOpenNextCloudflareForDev`).
 * Evidencia real: cron de PRODUCAO falhando em todo tick e linhas da fila de
 * e-mail presas em 'enviando' com attempts subindo sem parar, enquanto staging
 * rodava limpo — a mesma corrida, com outro interleaving.
 *
 * Cada execucao passa a valer pelo SEU contexto de async: concorrencia nao se
 * mistura, nao ha `finally` que apague a binding de quem ainda precisa dela, e
 * aninhamento (runWithDb dentro de runWithDb) resolve sozinho.
 */
const alsDb: MemoriaAsync<D1Database> = (globalThis.__limasDbAls ??= novaMemoriaAsync<D1Database>());

/**
 * Banco da requisicao atual.
 *
 * Em producao vem do binding D1 do Worker. Os testes automatizados injetam um
 * D1 compativel em globalThis para exercitar as mesmas consultas SQL sem
 * precisar de infraestrutura Cloudflare. Fora de request quem entrega o binding
 * e runWithDb (cron) — so cai em getCloudflareContext() quando nao ha contexto
 * nenhum, que e justamente o caso que nunca deve acontecer dentro do agendador.
 */
export async function runWithDb<T>(db: D1Database, fn: () => Promise<T>): Promise<T> {
  return alsDb.run(db, fn);
}

export function getDb(): D1Database {
  if (globalThis.__limasTestDb) return globalThis.__limasTestDb;
  const db = alsDb.getStore();
  if (db) return db;
  return getCloudflareContext().env.DB;
}

/* ------------------------------------------------------------------ */
/* Helpers de consulta                                                 */
/* ------------------------------------------------------------------ */

export async function all<T = Row>(sql: string, params: any[] = []): Promise<T[]> {
  const lote = alsLote.getStore();
  if (lote) return (await lerNoLote(lote, sql, params)) as T[];
  const db = getDb();
  marcarConsulta();
  const result = await db.prepare(sql).bind(...normalize(params)).all<T>();
  return result.results.map(plain) as T[];
}

export async function one<T = Row>(sql: string, params: any[] = []): Promise<T | undefined> {
  const lote = alsLote.getStore();
  if (lote) {
    const linhas = await lerNoLote(lote, sql, params);
    return (linhas[0] as T) ?? undefined;
  }
  const db = getDb();
  marcarConsulta();
  const row = await db.prepare(sql).bind(...normalize(params)).first<T>();
  return row === null ? undefined : (plain(row) as T);
}

/**
 * Mantem os resultados do D1 como objetos simples antes de entrega-los aos
 * Client Components do React.
 */
function plain<T>(row: T): T {
  return { ...(row as object) } as T;
}

export async function run(sql: string, params: any[] = []) {
  const db = getDb();
  marcarConsulta();
  return db.prepare(sql).bind(...normalize(params)).run();
}

export async function insert(sql: string, params: any[] = []): Promise<number> {
  const result = await run(sql, params);
  return Number(result.meta.last_row_id);
}

export async function scalar<T = number>(sql: string, params: any[] = []): Promise<T> {
  const r = await one<Row>(sql, params);
  if (!r) return 0 as unknown as T;
  return Object.values(r)[0] as T;
}

/** SQLite nao aceita boolean/undefined/Date: normaliza para tipos suportados. */
function normalize(params: any[]): any[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === "boolean") return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === "object" && p !== null) return JSON.stringify(p);
    return p;
  });
}

/**
 * Agrupa escritas relacionadas.
 *
 * O D1 nao oferece transacao interativa (BEGIN/COMMIT dirigido pela
 * aplicacao), apenas `batch()` para um conjunto de statements ja conhecido.
 * Este helper legado NAO e uma transacao. Escritas que alteram a ocupacao de
 * reservas usam stock-write.ts: revisao otimista e batch atomico real.
 */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  return fn();
}

/* ------------------------------------------------------------------ */
/* Lote de leituras — uma ida ao D1 por onda de leitura                */
/* ------------------------------------------------------------------ */

type LeituraPendente = {
  sql: string;
  params: any[];
  resolve: (linhas: Row[]) => void;
  reject: (erro: unknown) => void;
};

type LoteDeLeituras = {
  pendentes: LeituraPendente[];
  /** Timer da proxima onda (null = nenhuma onda marcada). */
  onda: ReturnType<typeof setTimeout> | null;
  /** Ondas ja disparadas e ainda em voo. */
  emVoo: Promise<void>[];
};

declare global {
  // eslint-disable-next-line no-var
  var __limasLoteAls: MemoriaAsync<LoteDeLeituras> | undefined;
}

/**
 * ALS do lote compartilhada entre os DOIS bundles gerados pelo OpenNext
 * (mesmo truque do globalThis em perf.ts): sem uma instancia unica, o
 * contexto criado na pagina nao sobreviveria aos imports duplicados. A
 * fábrica mora em perf.ts para o build não gerar um aviso novo de Edge
 * Runtime — o `node:async_hooks` já entra pelo próprio perf.ts.
 */
const alsLote: MemoriaAsync<LoteDeLeituras> =
  (globalThis.__limasLoteAls ??= novaMemoriaAsync<LoteDeLeituras>());

/** Statements por `batch()` — margem de seguranca abaixo de qualquer limite. */
const TAMANHO_DO_LOTE = 25;

/**
 * Agrupa TODAS as leituras (all/one/scalar) feitas dentro de `fn` em
 * `batch()` do D1, uma ida por ONDA em vez de uma ida por consulta.
 *
 * POR QUE: o D1 e unitario por banco — ele processa uma consulta por vez
 * (docs de limites do D1), entao cada `all/one` e uma volta de rede ate a
 * primaria. Uma tela como /reservas/[id] faz ~37 leituras; em producao isso
 * virava ~37 voltas sequenciais/enfileiradas antes do primeiro byte. Aqui as
 * leituras disparadas na mesma volta do event loop sao agrupadas num unico
 * `batch()` (uma ida, statements executados em sequencia no servidor).
 *
 * COMO FUNCIONA: `all/one` dentro do lote nao executam na hora — entram numa
 * fila e a fila e descarregada num `setTimeout(0)`, que roda DEPOIS de toda a
 * volta corrente (inclusive as continuacoes que esperavam uma promessa ja
 * resolvida, como memo de sessao/settings). Cada nova volta de leitura vira
 * uma nova onda. Quem espera o resultado (`await all(...)`) simplesmente
 * espera a onda terminar.
 *
 * SEGURANCA:
 *  - e SO para leituras: `run/insert` continuam imediatas. Nao envolva
 *    escritas e leituras que dependam da ordem (read-after-write) num lote.
 *  - `batch()` e atomico: se UM statement falhar, o lote inteiro falha. Nesse
 *    caso cada statement e refazido SOZINHO, entao uma consulta ruim derruba
 *    apenas ela mesma — o mesmo comportamento de antes do lote (quem chama com
 *    `.catch()` continua vendo o erro so da propria leitura).
 *  - o contexto morre com `fn`: leituras que ficaram sem dono sao drenadas no
 *    `finally`, para ninguem ficar com promessa pendurada.
 *  - sem contexto (testes, scripts, cron sem wrapper) e passthrough puro: nada
 *    muda fora de quem chama emLoteLeituras.
 *
 * ANINHAMENTO: se ja estamos num lote, o chamado interno e apenas `fn()` —
 * o lote externo e quem descarrega.
 */
export async function emLoteLeituras<T>(fn: () => Promise<T>): Promise<T> {
  if (alsLote.getStore()) return fn();
  const lote: LoteDeLeituras = { pendentes: [], onda: null, emVoo: [] };
  try {
    return await alsLote.run(lote, fn);
  } finally {
    if (lote.onda !== null) {
      clearTimeout(lote.onda);
      lote.onda = null;
    }
    // Drena o que faltou e espera as ondas em voo: `fn` so devolve depois de
    // toda leitura que ele proprio disparou ter terminado (ou rejeitado).
    for (;;) {
      if (lote.pendentes.length) {
        await drenarOnda(lote).catch(() => {});
        continue;
      }
      if (lote.emVoo.length) {
        await Promise.allSettled(lote.emVoo);
        continue;
      }
      break;
    }
  }
}

/** Enfileira a leitura e marca a onda que a descarrega. */
function lerNoLote(lote: LoteDeLeituras, sql: string, params: any[]): Promise<Row[]> {
  return new Promise<Row[]>((resolve, reject) => {
    lote.pendentes.push({ sql, params: normalize(params), resolve, reject });
    if (lote.onda !== null) return;
    lote.onda = setTimeout(() => {
      lote.onda = null;
      void drenarOnda(lote).catch(() => {});
    }, 0);
  });
}

/** Descarrega uma onda: tudo que foi registrado ate aqui vira um batch. */
async function drenarOnda(lote: LoteDeLeituras): Promise<void> {
  const lidos = lote.pendentes.splice(0, lote.pendentes.length);
  if (!lidos.length) return;
  const onda = executarEmLotes(lidos);
  lote.emVoo.push(onda);
  try {
    await onda;
  } finally {
    const i = lote.emVoo.indexOf(onda);
    if (i >= 0) lote.emVoo.splice(i, 1);
  }
}

async function executarEmLotes(lidos: LeituraPendente[]): Promise<void> {
  const db = getDb();
  for (let i = 0; i < lidos.length; i += TAMANHO_DO_LOTE) {
    const fatia = lidos.slice(i, i + TAMANHO_DO_LOTE);
    try {
      // Um batch e UMA ida ao D1 (conta como 1 na observabilidade).
      marcarConsulta();
      const resultados = await db.batch(fatia.map((s) => db.prepare(s.sql).bind(...s.params)));
      for (let j = 0; j < fatia.length; j++) {
        const linhas = ((resultados[j] as any)?.results ?? []) as Row[];
        fatia[j].resolve(linhas.map(plain));
      }
    } catch {
      // Fallback statement a statement: uma falha do lote nao pode derrubar
      // as demais leituras da onda. Cada leitura resolve ou rejeita sozinha,
      // exatamente como antes de existir o lote.
      for (const s of fatia) {
        try {
          marcarConsulta();
          const r = await db.prepare(s.sql).bind(...s.params).all();
          s.resolve((r.results as Row[]).map(plain));
        } catch (erro) {
          s.reject(erro);
        }
      }
    }
  }
}

/** Executa varios statements atomicamente (transacao unica no D1). */
export async function batch(statements: { sql: string; params?: any[] }[]) {
  if (!statements.length) return [];
  const db = getDb();
  // Um batch e UMA ida ao D1 (transacao unica): conta como 1, nao como N.
  marcarConsulta();
  return db.batch(statements.map((s) => db.prepare(s.sql).bind(...normalize(s.params ?? []))));
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Multi-tenant: empresa padrao, numeracao e settings por empresa       */
/* ------------------------------------------------------------------ */

let empresaPadraoPromise: Promise<number | null> | null = null;

/**
 * Empresa padrao do banco atual.
 *
 * Producao: as escritas de usuario SEMPRE recebem company_id explicito do
 * contexto autenticado (auth.ts) — este fallback nao e fonte de autoridade.
 * Serve as rotinas de plataforma (cron, seed) e aos testes, que criam banco
 * novo por suite. A leitura e cacheada por processo/banco.
 */
export async function defaultCompanyId(): Promise<number | null> {
  if (empresaPadraoPromise) return empresaPadraoPromise;
  empresaPadraoPromise = (async () => {
    try {
      const r = await getDb().prepare("SELECT MIN(id) AS id FROM companies").first<{ id: number | null }>();
      const id = r?.id ?? null;
      if (id !== null) globalThis.__limasDefaultCompany = id;
      return id;
    } catch {
      return null; // banco indisponivel ou ainda sem a tabela (nada a fazer)
    }
  })();
  return empresaPadraoPromise;
}

/** Empresa padrao garantida (cria a empresa 1 se o banco nao tiver nenhuma). */
export async function currentCompanyId(): Promise<number> {
  // Contexto fixado (cron, via runWithCompany) tem prioridade: e a empresa que
  // as rotinas de plataforma estao processando neste momento.
  if (empresaForaRequest !== undefined) return empresaForaRequest;
  const id = await defaultCompanyId();
  if (id !== null) return id;
  await run(`INSERT INTO companies (id, name, active) VALUES (1, 'Empresa', 1)`).catch(() => {});
  globalThis.__limasDefaultCompany = 1;
  return 1;
}

/** Limpa o cache da empresa padrao (usado ao trocar o banco de teste). */
export function resetCompanyCache() {
  empresaPadraoPromise = null;
  globalThis.__limasDefaultCompany = undefined;
  resetCompanyContext();
}

/* ------------------------------------------------------------------ */
/* Contexto de empresa para rotinas fora de request (cron)              */
/* ------------------------------------------------------------------ */

let empresaForaRequest: number | undefined;

/** Valor atual do contexto fora de request (undefined = nao fixado). */
export function companyContextAtual(): number | undefined {
  return empresaForaRequest;
}

/**
 * Empresa ativa para rotinas fora de request.
 *
 * O agendador do Worker itera as empresas (companies) e, dentro de cada
 * iteracao, os modulos de plataforma (fidelidade, aniversarios, notificacoes)
 * leem daqui o company_id que escopa suas queries. Em request, a autoridade
 * e sempre a sessao (auth.ts) — este contexto nunca e consultado la.
 */
export async function cronCompanyId(): Promise<number> {
  if (empresaForaRequest !== undefined) return empresaForaRequest;
  return currentCompanyId();
}

/** Define a empresa das rotinas fora de request (usado por runWithCompany). */
export function setCompanyContext(companyId: number | undefined) {
  empresaForaRequest = companyId;
}

/** Executa `fn` com o contexto de empresa fixado (padrao do cron). */
export async function runWithCompany<T>(companyId: number, fn: () => Promise<T>): Promise<T> {
  const anterior = empresaForaRequest;
  empresaForaRequest = companyId;
  try {
    return await fn();
  } finally {
    empresaForaRequest = anterior;
  }
}

/** Limpa o contexto de empresa fora de request (limpeza entre suites). */
export function resetCompanyContext() {
  empresaForaRequest = undefined;
}

/**
 * Sequencia de numeracao por empresa (migration 0027: doc_number_counters).
 *
 * O contador (company_id, prefix) e a fonte da sequencia; o maior numero JA
 * EXISTENTE no documento entra na conta por seguranca — bases importadas com
 * numeros acima do contador nunca sao reescritas. O prefixo em si e
 * configuravel por empresa (company_settings.doc_prefix_*); a funcao controla
 * apenas o numero.
 */
export async function proximaSequencia(
  table: "reservations" | "quotes" | "freights" | "contracts" | "purchases" | "financial_entries",
  prefix: string,
  minima: number,
  quantidade = 1,
): Promise<number> {
  /*
   * A sequência é POR EMPRESA. Em request, o tenant vem da SESSÃO
   * (tenantCompanyId) — usar currentCompanyId() aqui fazia TODAS as empresas
   * numerar com o contador da empresa 1 (fallback do banco). Fora de request
   * (cron/seed/testes) o comportamento anterior é preservado.
   */
  let companyId: number;
  try {
    const { tenantCompanyId } = await import("./tenant");
    companyId = await tenantCompanyId();
  } catch {
    companyId = await currentCompanyId();
  }
  // Garante a linha; nunca rebaixa abaixo do maior numero ja visto.
  await run(
    `INSERT INTO doc_number_counters (company_id, prefix, next_seq) VALUES (?,?,?)
       ON CONFLICT(company_id, prefix) DO UPDATE SET
         next_seq = MAX(next_seq, excluded.next_seq)`,
    [companyId, prefix, minima],
  );
  const row = await one<{ next_seq: number }>(
    `SELECT next_seq FROM doc_number_counters WHERE company_id = ? AND prefix = ?`,
    [companyId, prefix],
  );
  const inicio = Math.max(row?.next_seq ?? minima, minima);
  // Avanca SEMPRE: duas chamadas seguidas nunca devolvem o mesmo numero,
  // mesmo que nenhum documento tenha sido gravado entre elas (o UNIQUE da
  // tabela recusaria a duplicata, mas o certo e a sequencia crescer).
  await run(`UPDATE doc_number_counters SET next_seq = ? WHERE company_id = ? AND prefix = ?`, [
    inicio + quantidade, companyId, prefix,
  ]);
  return inicio;
}

/** Configuracoes (KV) de uma empresa — migration 0027: company_settings. */
export async function companySettingsRows(companyId: number): Promise<{ key: string; value: string | null }[]> {
  return all(`SELECT key, value FROM company_settings WHERE company_id = ?`, [companyId]);
}

/** Grava/atualiza configuracoes de uma empresa. */
export async function setCompanySettings(companyId: number, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    await run(
      `INSERT INTO company_settings (company_id, key, value) VALUES (?,?,?)
         ON CONFLICT(company_id, key) DO UPDATE SET value = excluded.value`,
      [companyId, key, value],
    );
  }
}

/** Gera o proximo numero sequencial de um documento (LIMA-001, FRT-001, ...). */
export async function nextNumber(
  table: "reservations" | "quotes" | "freights" | "contracts" | "purchases" | "financial_entries",
  prefix: string,
): Promise<string> {
  const row = await one<{ n: string }>(
    `SELECT number AS n FROM ${table} WHERE number LIKE ? ORDER BY LENGTH(number) DESC, number DESC LIMIT 1`,
    [prefix + "-%"],
  );
  const last = row ? parseInt(row.n.split("-").pop() ?? "0", 10) : 0;
  const proximo = await proximaSequencia(table, prefix, last + 1);
  return `${prefix}-${String(proximo).padStart(3, "0")}`;
}

/**
 * Proximo codigo de produto livre (PROD-001, PROD-002, ...).
 *
 * Mesmo formato PREFIXO-000 do nextNumber dos documentos e coerente com o
 * padrao de unidades (PROD-001-001). O maior codigo ja usado e lido no
 * GLOBAL (o UNIQUE de products.code, migration 0001, vale para toda a base,
 * nao so para a empresa), entao duas empresas nunca disputam o mesmo numero
 * em serie. Criacoes simultaneas que ainda assim colidirem sao resolvidas
 * pelo retry do createProduct — o banco e quem garante a unicidade final.
 */
export async function nextProductCode(): Promise<string> {
  const row = await one<{ n: string | null }>(
    `SELECT code AS n FROM products WHERE code LIKE 'PROD-%' ORDER BY LENGTH(code) DESC, code DESC LIMIT 1`,
  );
  const ultimo = row?.n ? parseInt(row.n.split("-").pop() ?? "0", 10) || 0 : 0;
  return `PROD-${String(ultimo + 1).padStart(3, "0")}`;
}

/** Violacao de UNIQUE (D1/SQLite) — usada para retry de codigo gerado. */
export function isUniqueViolation(e: unknown): boolean {
  return /unique/i.test(String((e as Error)?.message ?? e));
}

/**
 * Gera uma SEQUENCIA de numeros de documentos (parcelamento N parcelas).
 *
 * Uma unica consulta substitui N: antes, cada parcela buscava "o ultimo
 * numero" de novo, e o custo crescia linearmente com a quantidade de
 * parcelas. Mesma regra de formatacao do nextNumber, com todos os valores
 * calculados em memoria a partir da mesma leitura.
 */
export async function nextNumbers(
  table: "reservations" | "quotes" | "freights" | "contracts" | "purchases" | "financial_entries",
  prefix: string,
  quantidade: number,
): Promise<string[]> {
  const n = Math.max(1, Math.floor(quantidade));
  const row = await one<{ n: string }>(
    `SELECT number AS n FROM ${table} WHERE number LIKE ? ORDER BY LENGTH(number) DESC, number DESC LIMIT 1`,
    [prefix + "-%"],
  );
  const last = row ? parseInt(row.n.split("-").pop() ?? "0", 10) : 0;
  const inicio = await proximaSequencia(table, prefix, last + 1, n);
  return Array.from({ length: n }, (_, i) => `${prefix}-${String(inicio + i).padStart(3, "0")}`);
}
