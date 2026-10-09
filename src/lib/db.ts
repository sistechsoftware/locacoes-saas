import { getCloudflareContext } from "@opennextjs/cloudflare";

type Row = Record<string, any>;

declare global {
  // eslint-disable-next-line no-var
  var __limasTestDb: D1Database | undefined;
  /** Empresa padrao do banco (rotinas de plataforma/testes; producao usa sessao). */
  // eslint-disable-next-line no-var
  var __limasDefaultCompany: number | undefined;
}

/**
 * Banco da requisicao atual.
 *
 * Em producao vem do binding D1 do Worker. Os testes automatizados injetam um
 * D1 compativel em globalThis para exercitar as mesmas consultas SQL sem
 * precisar de infraestrutura Cloudflare.
 */
/**
 * Banco fornecido explicitamente por quem roda fora de uma requisicao.
 *
 * O cron do Worker nao tem contexto de requisicao, entao getCloudflareContext()
 * nao serve la. Em vez de duplicar todo o acesso a dados so para o agendador,
 * ele passa o binding por aqui. Todas as execucoes usam o mesmo env.DB, entao
 * uma sobreposicao momentanea nao muda o banco de ninguem.
 */
let dbDoAgendador: D1Database | undefined;

export async function runWithDb<T>(db: D1Database, fn: () => Promise<T>): Promise<T> {
  const anterior = dbDoAgendador;
  dbDoAgendador = db;
  try {
    return await fn();
  } finally {
    dbDoAgendador = anterior;
  }
}

export function getDb(): D1Database {
  if (globalThis.__limasTestDb) return globalThis.__limasTestDb;
  if (dbDoAgendador) return dbDoAgendador;
  return getCloudflareContext().env.DB;
}

/* ------------------------------------------------------------------ */
/* Helpers de consulta                                                 */
/* ------------------------------------------------------------------ */

export async function all<T = Row>(sql: string, params: any[] = []): Promise<T[]> {
  const db = getDb();
  const result = await db.prepare(sql).bind(...normalize(params)).all<T>();
  return result.results.map(plain) as T[];
}

export async function one<T = Row>(sql: string, params: any[] = []): Promise<T | undefined> {
  const db = getDb();
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

/** Executa varios statements atomicamente (transacao unica no D1). */
export async function batch(statements: { sql: string; params?: any[] }[]) {
  if (!statements.length) return [];
  const db = getDb();
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
