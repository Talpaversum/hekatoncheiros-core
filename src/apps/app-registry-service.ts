import { getPool } from "../db/pool.js";

import type { AppManifest } from "./manifest-validator.js";

export interface AppRegisterResponse {
  app_id: string;
  version: string;
  status: "registered";
}

export async function registerApp(manifest: AppManifest): Promise<AppRegisterResponse> {
  const pool = getPool();
  const appId = (manifest["app_id"] ?? "") as string;
  const version = (manifest["version"] ?? "") as string;
  const vendor = (manifest["vendor"] as { name?: string } | undefined)?.name ?? "unknown";
  const manifestJson = JSON.stringify(manifest);

  await pool.query(
    "insert into core.apps (app_id, vendor, latest_version, manifest_hash) values ($1, $2, $3, $4) on conflict (app_id) do update set latest_version = excluded.latest_version",
    [appId, vendor, version, "hash_stub"],
  );

  await pool.query(
    "insert into core.app_versions (app_id, version, manifest_json) values ($1, $2, $3) on conflict (app_id, version) do nothing",
    [appId, version, manifestJson],
  );

  return { app_id: appId, version, status: "registered" };
}

export async function enableAppForTenant(params: {
  tenantId: string;
  appId: string;
  version: string;
  config: Record<string, unknown> | null;
}) {
  const pool = getPool();
  await pool.query(
    "insert into core.tenant_apps (tenant_id, app_id, enabled, version_pinned, config) values ($1, $2, true, $3, $4) on conflict (tenant_id, app_id) do update set enabled = true, version_pinned = excluded.version_pinned, config = excluded.config",
    [params.tenantId, params.appId, params.version, params.config ?? {}],
  );
  return { enabled: true, app_id: params.appId, version: params.version };
}

export async function disableAppForTenant(tenantId: string, appId: string) {
  const pool = getPool();
  await pool.query(
    "update core.tenant_apps set enabled = false where tenant_id = $1 and app_id = $2",
    [tenantId, appId],
  );
}
