import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("tenant membership RBAC migration", () => {
  it("backfills memberships without consuming direct grants", async () => {
    const sql = await readFile(
      new URL("../src/db/migrations/040_tenant_membership_rbac_ownership.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("insert into core.tenant_memberships");
    expect(sql).toContain("from core.user_privileges");
    expect(sql).not.toContain("delete from core.user_privileges");
    expect(sql).toContain("key = 'tenant_member'");
  });

  it("models personal ownership without a fake tenant", async () => {
    const sql = await readFile(
      new URL("../src/db/migrations/040_tenant_membership_rbac_ownership.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("owner_type in ('user', 'tenant')");
    expect(sql).toContain("owner_type = 'user' and tenant_id is null");
  });

  it("maps unambiguous legacy administrator and auditor grants to roles", async () => {
    const sql = await readFile(
      new URL("../src/db/migrations/042_map_legacy_tenant_roles.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toContain("grant_record.privilege='tenant.config.manage'");
    expect(sql).toContain("role.key='tenant_admin'");
    expect(sql).toContain("role.key='tenant_auditor'");
    expect(sql).not.toContain("delete from core.user_privileges");
  });
});
