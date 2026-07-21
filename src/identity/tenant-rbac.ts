import type { PoolClient } from "pg";

export const SYSTEM_TENANT_ROLES = [
  {
    key: "tenant_member",
    name: "Tenant member",
    description: "Base membership role. It intentionally grants no administrative privileges.",
    privileges: [],
  },
  {
    key: "tenant_admin",
    name: "Tenant administrator",
    description: "Manages tenant details, members, roles, and tenant privileges.",
    privileges: [
      "tenant.members.read",
      "tenant.members.manage",
      "tenant.roles.read",
      "tenant.roles.manage",
      "tenant.privileges.read",
      "tenant.privileges.manage",
      "tenant.config.manage",
    ],
  },
  {
    key: "tenant_auditor",
    name: "Tenant auditor",
    description: "Reads tenant membership, role configuration, and tenant audit events.",
    privileges: [
      "tenant.members.read",
      "tenant.roles.read",
      "tenant.privileges.read",
      "core.audit.read.tenant",
    ],
  },
] as const;

export async function provisionSystemTenantRoles(client: PoolClient, tenantId: string) {
  for (const role of SYSTEM_TENANT_ROLES) {
    const result = await client.query(
      `insert into core.tenant_roles (tenant_id, key, name, description, is_system)
       values ($1, $2, $3, $4, true)
       on conflict (tenant_id, key) do update set name=excluded.name, description=excluded.description
       returning id`,
      [tenantId, role.key, role.name, role.description],
    );
    for (const privilege of role.privileges) {
      await client.query(
        "insert into core.role_privileges (role_id, privilege_key) values ($1, $2) on conflict do nothing",
        [result.rows[0]["id"], privilege],
      );
    }
  }
}

export async function createTenantMembership(
  client: PoolClient,
  input: {
    tenantId: string;
    userId: string;
    status?: "active" | "inactive";
    roleIds?: string[];
    roleKeys?: string[];
  },
) {
  const membership = await client.query(
    `insert into core.tenant_memberships (tenant_id, user_id, status)
     values ($1, $2, $3)
     returning id, tenant_id, user_id, status, version, created_at, updated_at`,
    [input.tenantId, input.userId, input.status ?? "active"],
  );
  const roleResult = await client.query(
    `select id from core.tenant_roles
     where tenant_id=$1 and (key='tenant_member' or id::text=any($2::text[]) or key=any($3::text[]))`,
    [input.tenantId, input.roleIds ?? [], input.roleKeys ?? []],
  );
  for (const role of roleResult.rows) {
    await client.query(
      "insert into core.tenant_member_roles (tenant_membership_id, role_id) values ($1, $2) on conflict do nothing",
      [membership.rows[0]["id"], role["id"]],
    );
  }
  return membership.rows[0] as Record<string, unknown>;
}
