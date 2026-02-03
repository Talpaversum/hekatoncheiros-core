import { getPool } from "../db/pool.js";
import { NotFoundError } from "../shared/errors.js";

export interface AppLicenseRecord {
  app_id: string;
  state: "active" | "inactive" | "expired";
  plan: string | null;
  expires_at: string | null;
  features: Record<string, boolean>;
  limits: Record<string, unknown>;
}

export async function getAppLicense(tenantId: string, appId: string): Promise<AppLicenseRecord> {
  const pool = getPool();
  const result = await pool.query(
    "select app_id, status, plan, expires_at, entitlements_json from core.licenses where tenant_id = $1 and app_id = $2",
    [tenantId, appId],
  );
  if (result.rowCount === 0) {
    return {
      app_id: appId,
      state: "inactive",
      plan: null,
      expires_at: null,
      features: {},
      limits: {},
    };
  }
  const row = result.rows[0];
  const entitlements = (row.entitlements_json ?? {}) as { features?: Record<string, boolean>; limits?: Record<string, unknown> };

  return {
    app_id: row.app_id,
    state: row.status ?? "inactive",
    plan: row.plan ?? null,
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    features: entitlements.features ?? {},
    limits: entitlements.limits ?? {},
  };
}

export async function activateOfflineLicense(params: {
  tenantId: string;
  appId: string;
  licenseBlob: string;
  signature: string;
}): Promise<AppLicenseRecord> {
  const pool = getPool();
  const entitlements = { features: {}, limits: {} };
  const result = await pool.query(
    "insert into core.licenses (tenant_id, app_id, license_blob, signature, status, entitlements_json) values ($1, $2, $3, $4, $5, $6) on conflict (tenant_id, app_id) do update set license_blob = excluded.license_blob, signature = excluded.signature, status = excluded.status, entitlements_json = excluded.entitlements_json returning app_id, status, plan, expires_at, entitlements_json",
    [params.tenantId, params.appId, params.licenseBlob, params.signature, "active", entitlements],
  );
  const row = result.rows[0];
  return {
    app_id: row.app_id,
    state: row.status ?? "active",
    plan: row.plan ?? null,
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    features: entitlements.features ?? {},
    limits: entitlements.limits ?? {},
  };
}
