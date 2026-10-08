/**
 * Guarda de compatibilidade SQLite local ↔ D1 remoto.
 *
 * O SQLite de verdade (node:sqlite, usado por todos os testes) é MUITO mais
 * permissivo que o SQLite gerenciado do D1. Duas divergências já causaram
 * falha real em staging:
 *
 *  1. SQLITE_LIMIT_COMPOUND_SELECT: o local aceita até 500 termos; o D1
 *     remoto aceita apenas 5 (medido em 06/10/2026 em
 *     limas-saas-staging-db: 5 termos passam, 6 falham com
 *     "too many terms in compound SELECT: SQLITE_ERROR [code 7500]").
 *     A versão commitada da 0034 (UNION ALL de 12 tipos) morria SÓ no
 *     staging — os testes locais passavam — e derrubava a migration inteira
 *     com rollback. Corrigida com CTE + VALUES, sem compound SELECT.
 *
 *  2. Transação SQL explícita (SAVEPOINT, BEGIN TRANSACTION/IMMEDIATE/
 *     EXCLUSIVE, COMMIT, ROLLBACK) é rejeitada pelo D1 remoto (erro
 *     7000/7500 — padrão documentado desde a 0027): cada migration é um
 *     lote atômico próprio, sem controle de transação manual.
 *
 * Este teste varre migrations/ e o SQL embebido em src/ (template literals)
 * para que essas divergências sejam descobertas AQUI, em CI, e não no
 * `wrangler d1 migrations apply` de staging ou produção. Só se verifica o que
 * foi medido no D1 real: o SQLite local é mais permissivo, nunca menos, então
 * a guarda local reprova quem quebraria no remoto.
 *
 * tests/*.test.ts não são varridos: rodam só no SQLite local e nunca chegam
 * ao D1.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Limite MEDIDO no D1 remoto: 5 termos por compound SELECT (UNION/EXCEPT/INTERSECT). */
const MAX_COMPOUND = 5;

const walk = (dir: string, acc: string[] = []): string[] => {
  for (const nome of fs.readdirSync(dir)) {
    const cheio = path.join(dir, nome);
    if (fs.statSync(cheio).isDirectory()) walk(cheio, acc);
    else acc.push(cheio);
  }
  return acc;
};

/** Remove comentários (-- e /* *\/) e o CONTEÚDO de literais '...' e "...". */
function limpar(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === "-" && n === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && n === "*") {
      i += 2;
      while (i < sql.length && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      out += "''";
      i++;
      while (i < sql.length) {
        if (sql[i] === q) {
          if (sql[i + 1] === q) {
            i += 2; // aspa duplicada escapada
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Termos de um compound SELECT = operadores (UNION/EXCEPT/INTERSECT) + 1. */
function termosCompound(fragmento: string): number {
  return (fragmento.match(/\b(UNION|EXCEPT|INTERSECT)\b/gi)?.length ?? 0) + 1;
}

/** Violações de compound SELECT no limite do D1, uma por statement. */
function violacoesCompound(sql: string): string[] {
  const saida: string[] = [];
  for (const fragmento of limpar(sql).split(";")) {
    const termos = termosCompound(fragmento);
    if (termos > MAX_COMPOUND) {
      const resumo = fragmento.trim().replace(/\s+/g, " ").slice(0, 100);
      saida.push(`${termos} termos ("${resumo}")`);
    }
  }
  return saida;
}

/**
 * Transação explícita — o D1 remoto rejeita (7000/7500). `OR ROLLBACK` de
 * resolução de conflito do INSERT também é sinalizado de propósito: sem
 * transação explícita disponível no D1 ele não faz o que o autor espera.
 * O BEGIN ... END de TRIGGER não casa (exige TRANSACTION/IMMEDIATE/EXCLUSIVE
 * depois do BEGIN).
 */
const TX_EXPLICITA = /\bSAVEPOINT\b|\bCOMMIT\b|\bROLLBACK\b|\bBEGIN\s+(?:TRANSACTION|IMMEDIATE|EXCLUSIVE)\b/i;

describe("migrations compatíveis com o D1 remoto", () => {
  const dir = path.resolve("migrations");
  const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

  it("compound SELECT de no máximo 5 termos (limite medido no D1)", () => {
    const falhas: string[] = [];
    for (const nome of arquivos) {
      const sql = fs.readFileSync(path.join(dir, nome), "utf8");
      for (const v of violacoesCompound(sql)) falhas.push(`${nome}: ${v}`);
    }
    assert.deepEqual(
      falhas,
      [],
      `compound SELECT acima do limite do D1 remoto (5 termos) — a migration falharia no ` +
        `\`wrangler d1 migrations apply\` mesmo passando nos testes locais (limite 500). ` +
        `Use CTE com VALUES (ver 0034). Violações:\n  ${falhas.join("\n  ")}`,
    );
  });

  it("nenhuma transação SQL explícita (D1 rejeita erro 7000/7500)", () => {
    const falhas: string[] = [];
    for (const nome of arquivos) {
      const sql = limpar(fs.readFileSync(path.join(dir, nome), "utf8"));
      const m = sql.match(TX_EXPLICITA);
      if (m) falhas.push(`${nome}: "${m[0]}"`);
    }
    assert.deepEqual(
      falhas,
      [],
      `SAVEPOINT/BEGIN TRANSACTION/COMMIT/ROLLBACK em migration: o D1 remoto rejeita transação ` +
        `SQL explícita (erros 7000/7500). Cada migration é um lote atômico próprio, sem controle ` +
        `manual (padrão da 0027). Violações:\n  ${falhas.join("\n  ")}`,
    );
  });

  it("a guarda reprova de verdade um compound SELECT de 6 termos", () => {
    const seisTermos = Array.from({ length: 6 }, (_, i) => `SELECT ${i}`).join(" UNION ");
    assert.equal(termosCompound(seisTermos), 6);
    assert.equal(violacoesCompound(seisTermos).length, 1);
    assert.deepEqual(violacoesCompound(`SELECT 1 UNION ALL SELECT 2`), []);
  });
});

describe("SQL embebido em src/ compatível com o D1 remoto", () => {
  it("compound SELECT de no máximo 5 termos nas consultas em template literals", () => {
    const arquivos = [
      ...walk(path.resolve("src")).filter((f) => /\.(ts|tsx)$/.test(f)),
      path.resolve("custom-worker.ts"),
    ];
    const falhas: string[] = [];
    for (const arquivo of arquivos) {
      const conteudo = fs.readFileSync(arquivo, "utf8");
      // Literais de crase: é onde vive o SQL (o conteúdo entre ` ` de cada um).
      for (const lit of conteudo.match(/`([^`]*)`/g) ?? []) {
        const corpo = lit.slice(1, -1);
        for (const v of violacoesCompound(corpo)) {
          falhas.push(`${path.relative(process.cwd(), arquivo)}: ${v}`);
        }
      }
    }
    assert.deepEqual(
      falhas,
      [],
      `compound SELECT acima do limite do D1 remoto (5 termos) em SQL de runtime — falharia em ` +
        `produção mesmo passando nos testes locais (limite 500). Violações:\n  ${falhas.join("\n  ")}`,
    );
  });
});
