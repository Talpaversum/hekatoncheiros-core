import { createHash } from "node:crypto";

import { getPool } from "../db/pool.js";
import { loadConfig, type EnvConfig } from "../config/index.js";
import { issueInstallationCompleteToken } from "./installer-token.js";

import { deriveAppSchemaName } from "./app-schema.js";

import type { AppManifest } from "./manifest-validator.js";

export interface AppRegisterResponse {
  app_id: string;
  version: string;
  status: "registered";
}

type MigrationManifestItem = {
  id: string;
  sha256: string;
};

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function migrationSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function setInstallationState(params: {
  tenantId: string;
  appId: string;
  state: "registered" | "installing" | "migrating" | "ready" | "failed" | "disabled";
  errorMessage?: string;
}) {
  const pool = getPool();
  await pool.query(
    `insert into core.app_installations (tenant_id, app_id, state, error_message, updated_at)
     values ($1, $2, $3, $4, now())
     on conflict (tenant_id, app_id)
     do update set state = excluded.state, error_message = excluded.error_message, updated_at = now()`,
    [params.tenantId, params.appId, params.state, params.errorMessage ?? null],
  );
}

async function fetchMigrations(baseUrl: string): Promise<Array<{ id: string; sql: string }>> {
  const indexUrl = new URL("/.well-known/hc/migrations", baseUrl);
  const indexResponse = await fetch(indexUrl);
  if (indexResponse.status !== 200) {
    throw new Error(`Cannot fetch migration index: ${indexResponse.status}`);
  }

  const body = (await indexResponse.json()) as { items?: MigrationManifestItem[] };
  const items = Array.isArray(body.items) ? body.items : [];
  const migrations: Array<{ id: string; sql: string }> = [];

  for (const item of items) {
    if (!item?.id || !item?.sha256) {
      throw new Error("Invalid migration manifest item");
    }
    const sqlUrl = new URL(`/.well-known/hc/migrations/${encodeURIComponent(item.id)}`, baseUrl);
    const sqlResponse = await fetch(sqlUrl);
    if (sqlResponse.status !== 200) {
      throw new Error(`Cannot fetch migration ${item.id}: ${sqlResponse.status}`);
    }
    const sql = await sqlResponse.text();
    const actualHash = migrationSha256(sql);
    if (actualHash !== item.sha256) {
      throw new Error(`Migration hash mismatch for ${item.id}`);
    }
    migrations.push({ id: item.id, sql });
  }

  return migrations;
}

async function applyAppMigrations(params: { appId: string; baseUrl: string }) {
  const pool = getPool();
  const schemaName = deriveAppSchemaName(params.appId);
  const migrations = await fetchMigrations(params.baseUrl);

  await pool.query(`create schema if not exists ${schemaName}`);

  for (const migration of migrations) {
    await pool.query("begin");
    try {
      await pool.query(`set local search_path to ${schemaName}`);
      await pool.query(migration.sql);
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback");
      throw error;
    }
  }
}

async function ensureAppRole(params: { tenantId: string; appId: string }) {
  const pool = getPool();
  const schemaName = deriveAppSchemaName(params.appId);
  const roleName = `hc_app_${deriveAppSchemaName(params.appId).replace(/^app_/, "")}`;

  const roleExists = await pool.query("select 1 from pg_roles where rolname = $1", [roleName]);
  if ((roleExists.rowCount ?? 0) === 0) {
    await pool.query(`create role ${quoteIdentifier(roleName)}`);
  }
  await pool.query(`grant usage on schema ${schemaName} to ${quoteIdentifier(roleName)}`);
  await pool.query(`grant select, insert, update, delete on all tables in schema ${schemaName} to ${quoteIdentifier(roleName)}`);
  await pool.query(`alter default privileges in schema ${schemaName} grant select, insert, update, delete on tables to ${quoteIdentifier(roleName)}`);

  await pool.query(
    `insert into core.app_db_roles (tenant_id, app_id, role_name, updated_at)
     values ($1,$2,$3, now())
     on conflict (tenant_id, app_id)
     do update set role_name = excluded.role_name, updated_at = now()`,
    [params.tenantId, params.appId, roleName],
  );
}

async function notifyInstallationComplete(params: {
  tenantId: string;
  appId: string;
  baseUrl: string;
  config: EnvConfig;
}) {
  const token = await issueInstallationCompleteToken({
    appId: params.appId,
    tenantId: params.tenantId,
    config: params.config,
  });

  const response = await fetch(new URL("/.well-known/hc/installation/complete", params.baseUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ tenant_id: params.tenantId, app_id: params.appId }),
  });

  if (response.status !== 200) {
    throw new Error(`installation/complete callback failed: ${response.status}`);
  }
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
  baseUrl?: string;
}) {
  const pool = getPool();
  const appInfo = await pool.query("select base_url from core.installed_apps where app_id = $1", [params.appId]);
  const resolvedBaseUrl = params.baseUrl ?? (appInfo.rows[0]?.base_url as string | undefined);
  if (!resolvedBaseUrl) {
    throw new Error("Cannot resolve app base_url for migration flow");
  }

  await setInstallationState({ tenantId: params.tenantId, appId: params.appId, state: "installing" });
  try {
    await setInstallationState({ tenantId: params.tenantId, appId: params.appId, state: "migrating" });
    await applyAppMigrations({ appId: params.appId, baseUrl: resolvedBaseUrl });
    await ensureAppRole({ tenantId: params.tenantId, appId: params.appId });
    await notifyInstallationComplete({
      tenantId: params.tenantId,
      appId: params.appId,
      baseUrl: resolvedBaseUrl,
      config: loadConfig(),
    });
    await setInstallationState({ tenantId: params.tenantId, appId: params.appId, state: "ready" });
  } catch (error) {
    await setInstallationState({
      tenantId: params.tenantId,
      appId: params.appId,
      state: "failed",
      errorMessage: (error as Error).message,
    });
    throw error;
  }

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
  await setInstallationState({ tenantId, appId, state: "disabled" });
}
