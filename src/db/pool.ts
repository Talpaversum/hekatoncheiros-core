import pg from "pg";

import { loadConfig } from "../config/index.js";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const config = loadConfig();
    pool = new Pool({ connectionString: config.DATABASE_URL });
  }
  return pool;
}
