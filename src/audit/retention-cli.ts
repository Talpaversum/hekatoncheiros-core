import { loadConfig } from "../config/index.js";
import { getPool } from "../db/pool.js";

import { runAuditRetention } from "./audit-retention.js";

const config = loadConfig();
runAuditRetention(config.AUDIT_RETENTION_DAYS, config.AUDIT_RETENTION_BATCH_SIZE)
  .then(async (deleted) => {
    console.info(`Deleted ${deleted} expired audit events`);
    await getPool().end();
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
