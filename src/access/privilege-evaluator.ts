import { getPool } from "../db/pool.js";

export async function loadPrivilegesForUser(userId: string, tenantId: string): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query(
    "select privilege from core.user_privileges where user_id = $1 and tenant_id = $2",
    [userId, tenantId],
  );

  return result.rows.map((row) => row.privilege as string);
}
