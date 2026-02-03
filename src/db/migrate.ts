import { readFile } from "node:fs/promises";
import path from "node:path";

import { fileURLToPath } from "node:url";

import { getPool } from "./pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function run() {
  const pool = getPool();
  const migrationPath = path.resolve(__dirname, "migrations/001_init.sql");
  const sql = await readFile(migrationPath, "utf-8");
  await pool.query(sql);
  await pool.end();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
