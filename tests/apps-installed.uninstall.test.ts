import { randomUUID } from "node:crypto";

import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { getPool } from "../src/db/pool.js";

describe("DELETE /api/v1/apps/installed/:app_id", () => {
  const testUserId = "usr_test_uninstall";
  const testTenantId = "tnt_default";

  beforeAll(async () => {
    process.env["NODE_ENV"] = "test";
    process.env["DATABASE_URL"] = process.env["DATABASE_URL"] ?? "postgres://hc_user:hc_password@localhost:5432/hc_core";
    process.env["JWT_SECRET"] = "supersecretkeysupersecret";
    process.env["JWT_ISSUER"] = "hekatoncheiros-core";
    process.env["JWT_AUDIENCE_USER"] = "hc-user";
    process.env["JWT_AUDIENCE_APP"] = "hc-app";
    process.env["INSTALLER_TOKEN_SECRET"] = "installersecretinstallersecret";
    process.env["INSTALLER_TOKEN_ISSUER"] = "hekatoncheiros-core-installer";
    process.env["DEFAULT_TENANT_ID"] = testTenantId;
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from core.user_privileges where user_id = $1", [testUserId]);
  });

  it("removes app from DB and subsequent GET /apps/installed no longer returns it", async () => {
    const app = await buildApp();
    const pool = getPool();
    const appId = `test.uninstall.${randomUUID()}`;
    const slug = `test-uninstall-${randomUUID().slice(0, 8)}`;
    const baseUrl = `https://example-${randomUUID().slice(0, 8)}.test`;

    await pool.query(
      "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3) on conflict do nothing",
      [testUserId, null, "platform.apps.manage"],
    );

    await pool.query(
      `insert into core.installed_apps (
        app_id,
        slug,
        app_name,
        base_url,
        ui_url,
        ui_integrity,
        required_privileges,
        nav_entries,
        manifest_json,
        enabled,
        installed_at,
        updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, true, now(), now())
      on conflict (app_id)
      do update set
        slug = excluded.slug,
        app_name = excluded.app_name,
        base_url = excluded.base_url,
        ui_url = excluded.ui_url,
        ui_integrity = excluded.ui_integrity,
        required_privileges = excluded.required_privileges,
        nav_entries = excluded.nav_entries,
        manifest_json = excluded.manifest_json,
        enabled = true,
        updated_at = now()`,
      [appId, slug, "Test Uninstall App", baseUrl, `/api/v1/apps/${slug}/ui/plugin.js`, "sha256-test", [], "[]", "{}"],
    );

    const token = await new SignJWT({ tenant_id: testTenantId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(testUserId)
      .setIssuer(process.env["JWT_ISSUER"] ?? "hekatoncheiros-core")
      .setAudience(process.env["JWT_AUDIENCE_USER"] ?? "hc-user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(process.env["JWT_SECRET"] ?? "supersecretkeysupersecret"));

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: `/api/v1/apps/installed/${encodeURIComponent(appId)}`,
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(deleteResponse.statusCode).toBe(204);

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/v1/apps/installed",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(listResponse.statusCode).toBe(200);
    const payload = listResponse.json() as { items: Array<{ app_id: string }> };
    expect(payload.items.some((item) => item.app_id === appId)).toBe(false);

    await pool.query("delete from core.installed_apps where app_id = $1", [appId]);
    await app.close();
  });

  it("returns 404 when app is not installed", async () => {
    const app = await buildApp();

    const token = await new SignJWT({ tenant_id: testTenantId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(testUserId)
      .setIssuer(process.env["JWT_ISSUER"] ?? "hekatoncheiros-core")
      .setAudience(process.env["JWT_AUDIENCE_USER"] ?? "hc-user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(process.env["JWT_SECRET"] ?? "supersecretkeysupersecret"));

    const deleteResponse = await app.inject({
      method: "DELETE",
      url: "/api/v1/apps/installed/non-existent-app-id",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    expect(deleteResponse.statusCode).toBe(404);
    expect(deleteResponse.json()).toMatchObject({
      statusCode: 404,
      error: "Not Found",
      message: "App not installed",
    });
    await app.close();
  });
});
