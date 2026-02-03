import { getPool } from "../db/pool.js";

export async function recordAudit(params: {
  tenantId: string;
  actorUserId: string | null;
  effectiveUserId: string | null;
  action: string;
  objectRef: string;
  metadata: Record<string, unknown>;
}) {
  const pool = getPool();
  await pool.query(
    "insert into core.audit_log (tenant_id, actor_user_id, effective_user_id, action, object_ref, metadata) values ($1, $2, $3, $4, $5, $6)",
    [
      params.tenantId,
      params.actorUserId,
      params.effectiveUserId,
      params.action,
      params.objectRef,
      params.metadata,
    ],
  );
}
