/** Repro: aplica as migrations uma a uma e imprime o arquivo/statement que falha. */
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("migrations");
const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON");

for (const file of fs.readdirSync(dir).sort()) {
  if (!file.endsWith(".sql")) continue;
  const sql = fs.readFileSync(path.join(dir, file), "utf8");
  if (file < "0027") {
    try {
      db.exec(sql);
      console.log("OK      ", file);
    } catch (e) {
      console.log("FALHOU  ", file, "->", e.message);
      process.exit(1);
    }
    continue;
  }
  // aplica o arquivo inteiro, como o wrangler d1 migrations apply faz
  try {
    db.exec(sql);
    console.log("OK      ", file);
  } catch (e) {
    console.log("FALHOU  ", file, "->", e.message);
    process.exit(1);
  }
}
console.log("TODAS AS MIGRATIONS OK");
