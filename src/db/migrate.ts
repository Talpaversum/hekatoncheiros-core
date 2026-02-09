import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { fileURLToPath } from "node:url";

import { getPool } from "./pool.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function migrateDatabase(options?: { closePool?: boolean }) {
  const closePool = options?.closePool ?? true;
  const pool = getPool();
  const client = await pool.connect();

  await client.query("select pg_advisory_lock(hashtext('core_schema_migrations'))");
  try {
    await client.query("create schema if not exists core");

    await client.query(
      `create table if not exists core.schema_migrations (
         id bigserial primary key,
         filename text not null unique,
         applied_at timestamptz not null default now()
       )`,
    );

    const migrationsDir = path.resolve(__dirname, "migrations");
    const migrationFiles = (await readdir(migrationsDir))
      .filter((name) => name.endsWith(".sql"))
      .sort((a, b) => a.localeCompare(b));

    for (const filename of migrationFiles) {
      const alreadyApplied = await client.query(
        "select 1 from core.schema_migrations where filename = $1",
        [filename],
      );
      if ((alreadyApplied.rowCount ?? 0) > 0) {
        continue;
      }

      const migrationPath = path.join(migrationsDir, filename);
      const sql = await readFile(migrationPath, "utf-8");

      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into core.schema_migrations (filename) values ($1)", [filename]);
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      }
    }
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('core_schema_migrations'))");
    client.release();
  }

  if (closePool) {
    await pool.end();
  }
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isEntrypoint) {
  migrateDatabase().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
