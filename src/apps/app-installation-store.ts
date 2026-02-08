import { getPool } from "../db/pool.js";

type NavEntry = { label: string; path: string; required_privileges?: string[] };

export type InstalledApp = {
  app_id: string;
  slug: string;
  app_name?: string;
  base_url: string;
  ui_url: string;
  ui_integrity: string;
  required_privileges: string[];
  nav_entries?: NavEntry[];
  enabled?: boolean;
  manifest: {
    integration?: {
      ui?: {
        artifact?: {
          url?: string;
          auth?: string;
        };
        nav_entries?: NavEntry[];
      };
    };
  };
};

export interface AppInstallationStore {
  listInstalledApps(): Promise<InstalledApp[]>;
  getApp(appId: string): Promise<InstalledApp | null>;
  installApp(app: InstalledApp): Promise<void>;
  uninstallApp(appId: string): Promise<void>;
}

function readStringField(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readNavEntries(manifest: unknown): NavEntry[] {
  if (!manifest || typeof manifest !== "object") {
    return [];
  }

  const integration = (manifest as { integration?: unknown }).integration;
  if (!integration || typeof integration !== "object") {
    return [];
  }

  const ui = (integration as { ui?: unknown }).ui;
  if (!ui || typeof ui !== "object") {
    return [];
  }

  const navEntries = (ui as { nav_entries?: unknown }).nav_entries;
  if (!Array.isArray(navEntries)) {
    return [];
  }

  return navEntries as NavEntry[];
}

export class DbAppInstallationStore implements AppInstallationStore {
  async listInstalledApps(): Promise<InstalledApp[]> {
    const pool = getPool();
    const result = await pool.query(
      `select app_id, slug, app_name, base_url, ui_url, ui_integrity, required_privileges, nav_entries, manifest_json, enabled
       from core.installed_apps
       order by app_id asc`,
    );

    return result.rows.map((row) => {
      const manifest = (row.manifest_json ?? {}) as InstalledApp["manifest"];
      return {
        app_id: row.app_id,
        slug: row.slug,
        app_name: row.app_name ?? undefined,
        base_url: row.base_url,
        ui_url: row.ui_url,
        ui_integrity: row.ui_integrity,
        required_privileges: (row.required_privileges ?? []) as string[],
        nav_entries: (row.nav_entries ?? readNavEntries(manifest)) as NavEntry[],
        enabled: row.enabled ?? true,
        manifest,
      } satisfies InstalledApp;
    });
  }

  async getApp(appId: string): Promise<InstalledApp | null> {
    const pool = getPool();
    const result = await pool.query(
      `select app_id, slug, app_name, base_url, ui_url, ui_integrity, required_privileges, nav_entries, manifest_json, enabled
       from core.installed_apps
       where app_id = $1`,
      [appId],
    );

    if (result.rowCount === 0) {
      return null;
    }

    const row = result.rows[0];
    const manifest = (row.manifest_json ?? {}) as InstalledApp["manifest"];
    return {
      app_id: row.app_id,
      slug: row.slug,
      app_name: row.app_name ?? undefined,
      base_url: row.base_url,
      ui_url: row.ui_url,
      ui_integrity: row.ui_integrity,
      required_privileges: (row.required_privileges ?? []) as string[],
      nav_entries: (row.nav_entries ?? readNavEntries(manifest)) as NavEntry[],
      enabled: row.enabled ?? true,
      manifest,
    } satisfies InstalledApp;
  }

  async installApp(app: InstalledApp): Promise<void> {
    const pool = getPool();
    const appName = readStringField(app.manifest, "app_name") ?? null;
    const navEntries = readNavEntries(app.manifest);

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
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, now(), now())
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
      [
        app.app_id,
        app.slug,
        appName,
        app.base_url,
        app.ui_url,
        app.ui_integrity,
        app.required_privileges,
        navEntries,
        app.manifest,
      ],
    );
  }

  async uninstallApp(appId: string): Promise<void> {
    const pool = getPool();
    await pool.query("delete from core.installed_apps where app_id = $1", [appId]);
  }
}
