import { getPool } from "../db/pool.js";

export async function loadPrivilegesForUser(
  userId: string,
  tenantId: string | null,
): Promise<string[]> {
  const pool = getPool();
  const result = await pool.query(
    `select distinct privilege
       from (
         select privilege
           from core.user_privileges
          where user_id = $1 and (tenant_id is null or tenant_id = $2)
         union all
         select rp.privilege_key
           from core.tenant_memberships tm
           join core.tenant_member_roles tmr on tmr.tenant_membership_id = tm.id
           join core.tenant_roles tr on tr.id = tmr.role_id and tr.tenant_id = tm.tenant_id
           join core.role_privileges rp on rp.role_id = tr.id
          where tm.user_id = $1 and tm.tenant_id = $2 and tm.status = 'active'
       ) effective(privilege)`,
    [userId, tenantId],
  );

  return result.rows.map((row) => row.privilege as string);
}
