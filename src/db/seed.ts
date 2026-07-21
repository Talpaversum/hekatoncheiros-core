import { createHash } from "node:crypto";

import { provisionSystemTenantRoles } from "../identity/tenant-rbac.js";

import { getPool } from "./pool.js";

function hashPassword(password: string) {
  return createHash("sha256").update(password).digest("hex");
}

async function run() {
  const pool = getPool();
  const defaultTenantId = "tnt_default";
  await pool.query(
    "insert into core.tenants (id, name, primary_domain, status) values ($1, $2, $3, $4) on conflict do nothing",
    [defaultTenantId, "Default Tenant", "localhost", "active"],
  );
  await pool.query(
    "insert into core.users (id, email, password_hash, status) values ($1, $2, $3, $4) on conflict (id) do update set email = excluded.email, password_hash = excluded.password_hash, status = excluded.status",
    ["usr_admin", "admin@example.com", hashPassword("admin"), "active"],
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    await provisionSystemTenantRoles(client, defaultTenantId);
    const membership = await client.query(
      `insert into core.tenant_memberships(tenant_id,user_id,status) values($1,'usr_admin','active')
       on conflict(tenant_id,user_id) do update set status='active',updated_at=now() returning id`,
      [defaultTenantId],
    );
    await client.query(
      `insert into core.tenant_member_roles(tenant_membership_id,role_id)
       select $1,id from core.tenant_roles where tenant_id=$2 and key in ('tenant_member','tenant_admin')
       on conflict do nothing`,
      [membership.rows[0]["id"], defaultTenantId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
  await pool.query(
    "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
    ["usr_admin", null, "core.apps.register"],
  );
  await pool.query(
    "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
    ["usr_admin", null, "core.apps.enable"],
  );
  await pool.query(
    "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
    ["usr_admin", null, "core.apps.disable"],
  );
  await pool.query(
    "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
    ["usr_admin", null, "core.licensing.read"],
  );
  await pool.query(
    "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
    ["usr_admin", null, "core.licensing.ingest_offline"],
  );
  await pool.query(
    "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
    ["usr_admin", null, "core.licensing.manage_selection"],
  );
  await pool.query(
    "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
    ["usr_admin", null, "core.audit.append"],
  );
  for (const privilege of [
    "core.audit.read.own",
    "core.audit.read.tenant",
    "platform.audit.read",
    "platform.audit.retention.manage",
  ]) {
    await pool.query(
      "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
      ["usr_admin", privilege.startsWith("platform.") ? null : defaultTenantId, privilege],
    );
  }
  await pool.query(
    "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
    ["usr_admin", null, "platform.superadmin"],
  );
  await pool.query(
    "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
    ["usr_admin", defaultTenantId, "tenant.config.manage"],
  );
  for (const privilege of [
    "platform.authors.review",
    "platform.author_registry.read",
    "platform.author_registry.keys.manage",
    "platform.author_registry.certificates.issue",
    "platform.author_registry.revoke",
    "platform.author_registry.audit.read",
    "developer.projects.read",
    "developer.projects.create",
    "developer.projects.manage",
    "developer.connections.manage",
    "developer.connections.personal.manage",
    "developer.connections.shared.manage",
    "developer.connections.use",
    "developer.deployments.run",
    "developer.runtime.manage",
    "developer.logs.read",
    "licensing.products.manage",
    "licensing.customers.manage",
    "licensing.instances.manage",
    "licensing.grants.manage",
    "licensing.licenses.issue",
    "licensing.licenses.revoke",
    "licensing.activations.approve",
    "licensing.audit.read",
  ]) {
    await pool.query(
      "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
      ["usr_admin", privilege.startsWith("platform.") ? null : defaultTenantId, privilege],
    );
  }
  await pool.end();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
