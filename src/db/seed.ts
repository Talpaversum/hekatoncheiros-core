import { createHash } from "node:crypto";

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
  await pool.query(
    "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
    ["usr_admin", null, "platform.superadmin"],
  );
  await pool.query(
    "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
    ["usr_admin", defaultTenantId, "tenant.config.manage"],
  );
  await pool.end();
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
