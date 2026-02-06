import { getPool } from "../db/pool.js";

import { deriveAppSchemaName } from "./app-schema.js";

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
  const integration = manifest["integration"] as {
    slug?: string;
    api?: { exposes?: { base_path?: string } };
    ui?: { nav_entries?: Array<{ label: string; path: string; required_privileges?: string[] }> };
  };

  const slug = integration?.slug;
  const basePath = integration?.api?.exposes?.base_path;
  if (!slug || !basePath) {
    throw new Error("Manifest integration.slug and integration.api.exposes.base_path are required");
  }

  const normalizedBasePath = `/apps/${slug}`;
  if (basePath !== normalizedBasePath) {
    throw new Error("integration.api.exposes.base_path must match slug");
  }

  const rawNavEntries = (integration.ui?.nav_entries ?? []) as Array<{
    label: string;
    path: string;
    required_privileges?: string[];
  }>;
  const navEntries = rawNavEntries.map((entry) => {
    const normalizedPath = entry.path.replace(/^\/app\/[^/]+/, "");
    return {
      ...entry,
      path: `/app/${slug}${normalizedPath}`,
    };
  });

  const existing = await pool.query("select app_id, vendor from core.apps where app_id = $1", [appId]);
  if (existing.rows.length > 0 && existing.rows[0].vendor !== vendor) {
    throw new Error("app_id is already registered by a different vendor");
  }
  const slugCollision = await pool.query("select app_id from core.apps where app_id != $1 and (manifest_json->'integration'->>'slug') = $2", [appId, slug]);
  if (slugCollision.rows.length > 0) {
    throw new Error("integration.slug must be globally unique");
  }

  const normalizedManifest = {
    ...manifest,
    integration: {
      ...(manifest["integration"] as Record<string, unknown>),
      ui: {
        ...(integration?.ui as Record<string, unknown>),
        nav_entries: navEntries,
      },
    },
  };
  const normalizedJson = JSON.stringify(normalizedManifest);

  await pool.query(
    "insert into core.apps (app_id, vendor, latest_version, manifest_hash) values ($1, $2, $3, $4) on conflict (app_id) do update set latest_version = excluded.latest_version",
    [appId, vendor, version, "hash_stub"],
  );

  await pool.query(
    "insert into core.app_versions (app_id, version, manifest_json) values ($1, $2, $3) on conflict (app_id, version) do nothing",
    [appId, version, normalizedJson],
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
  const schemaName = deriveAppSchemaName(params.appId);
  await pool.query(`create schema if not exists ${schemaName}`);
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
