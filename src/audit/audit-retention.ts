import { getPool } from "../db/pool.js";

import { recordAudit } from "./audit-service.js";

export async function runAuditRetention(retentionDays: number, batchSize: number): Promise<number> {
  const pool = getPool();
  let deleted = 0;
  for (;;) {
    const result = await pool.query(
      `delete from core.audit_log where id in (
         select id from core.audit_log where occurred_at < now() - ($1 * interval '1 day')
         order by occurred_at asc limit $2
       )`,
      [retentionDays, batchSize],
    );
    deleted += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < batchSize) break;
  }
  await recordAudit({
    tenantId: null, actorType: "system", sourceService: "core-maintenance",
    eventType: "audit.retention.completed", category: "audit", action: "audit.retention.run",
    outcome: "success", severity: "info", scope: "platform", visibility: "platform_admin",
    message: "Audit retention completed", metadata: { retention_days: retentionDays, deleted_count: deleted },
  });
  return deleted;
}
