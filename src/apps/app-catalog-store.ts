import { getPool } from "../db/pool.js";
import type { FetchManifestResult } from "./manifest-fetcher.js";

type CatalogMetadata = Record<string, unknown>;
type CatalogDeployment = Record<string, unknown> & { type?: string };

export type AppCatalogSource = {
  id: string;
  name: string;
  source_type: "manual" | "feed";
  feed_url: string | null;
  trust_mode: "dev" | "manual" | "verified" | "official";
  is_enabled: boolean;
  last_sync_at: string | null;
  last_error: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type AppCatalogEntry = {
  app_id: string;
  source_id: string | null;
  source_type: "manual" | "feed";
  trust_status: "dev" | "manual" | "unverified" | "verified" | "official" | "rejected";
  author_id: string | null;
  namespace: string | null;
  slug: string;
  app_name: string;
  app_version: string;
  summary: string | null;
  base_url: string;
  manifest_url: string;
  manifest_hash: string;
  manifest_version: string;
  license_required: boolean;
  license_issuer_url: string | null;
  metadata: CatalogMetadata;
  deployment: CatalogDeployment;
  created_by: string | null;
  fetched_at: string;
  created_at: string;
  updated_at: string;
};

export type UpsertCatalogEntryInput = {
  fetched: FetchManifestResult;
  sourceId?: string | null;
  sourceType?: "manual" | "feed";
  trustStatus?: AppCatalogEntry["trust_status"];
  authorId?: string | null;
  summary?: string | null;
  metadata?: CatalogMetadata;
  deployment?: CatalogDeployment;
  createdBy?: string | null;
};

export type CreateCatalogSourceInput = {
  name: string;
  feedUrl: string;
  trustMode?: AppCatalogSource["trust_mode"];
  createdBy?: string | null;
};

function readString(source: unknown, key: string): string | null {
  if (!source || typeof source !== "object") {
    return null;
  }

  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function readNamespace(appId: string): string | null {
  const separator = appId.indexOf("/");
  if (separator <= 0) {
    return null;
  }
  return appId.slice(0, separator);
}

function readManifestMetadata(fetched: FetchManifestResult): {
  appId: string;
  slug: string;
  appName: string;
  licenseRequired: boolean;
  licenseIssuerUrl: string | null;
} {
  const manifest = fetched.manifest;
  const appId = readString(manifest, "app_id");
  const appName = readString(manifest, "app_name");
  const integration = manifest["integration"] as { slug?: unknown } | undefined;
  const slug = typeof integration?.slug === "string" ? integration.slug.trim() : "";
  const licensing = manifest["licensing"] as { required?: unknown; issuer_url?: unknown } | undefined;
  const issuerUrl = typeof licensing?.issuer_url === "string" ? licensing.issuer_url.trim() : "";

  if (!appId || !appName || !slug) {
    throw new Error("Manifest must contain app_id, app_name and integration.slug");
  }

  return {
    appId,
    slug,
    appName,
    licenseRequired: licensing?.required === true,
    licenseIssuerUrl: issuerUrl.length > 0 ? issuerUrl : null,
  };
}

function mapRow(row: Record<string, unknown>): AppCatalogEntry {
  return {
    app_id: String(row["app_id"]),
    source_id: (row["source_id"] as string | null) ?? null,
    source_type: String(row["source_type"]) as AppCatalogEntry["source_type"],
    trust_status: String(row["trust_status"]) as AppCatalogEntry["trust_status"],
    author_id: (row["author_id"] as string | null) ?? null,
    namespace: (row["namespace"] as string | null) ?? null,
    slug: String(row["slug"]),
    app_name: String(row["app_name"]),
    app_version: String(row["app_version"]),
    summary: (row["summary"] as string | null) ?? null,
    base_url: String(row["base_url"]),
    manifest_url: String(row["manifest_url"]),
    manifest_hash: String(row["manifest_hash"]),
    manifest_version: String(row["manifest_version"]),
    license_required: Boolean(row["license_required"]),
    license_issuer_url: (row["license_issuer_url"] as string | null) ?? null,
    metadata: (row["metadata_json"] ?? {}) as CatalogMetadata,
    deployment: (row["deployment_json"] ?? { type: "external" }) as CatalogDeployment,
    created_by: (row["created_by"] as string | null) ?? null,
    fetched_at: new Date(String(row["fetched_at"])).toISOString(),
    created_at: new Date(String(row["created_at"])).toISOString(),
    updated_at: new Date(String(row["updated_at"])).toISOString(),
  };
}

function mapSourceRow(row: Record<string, unknown>): AppCatalogSource {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    source_type: String(row["source_type"]) as AppCatalogSource["source_type"],
    feed_url: (row["feed_url"] as string | null) ?? null,
    trust_mode: String(row["trust_mode"]) as AppCatalogSource["trust_mode"],
    is_enabled: Boolean(row["is_enabled"]),
    last_sync_at: row["last_sync_at"] ? new Date(String(row["last_sync_at"])).toISOString() : null,
    last_error: (row["last_error"] as string | null) ?? null,
    created_by: (row["created_by"] as string | null) ?? null,
    created_at: new Date(String(row["created_at"])).toISOString(),
    updated_at: new Date(String(row["updated_at"])).toISOString(),
  };
}

function normalizeFeedUrl(input: string): string {
  const parsed = new URL(input.trim());
  if (parsed.username || parsed.password) {
    throw new Error("feed_url must not include username/password");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("feed_url must use http or https");
  }
  if (parsed.pathname === "/" || parsed.pathname === "") {
    parsed.pathname = "/.well-known/hc/app-catalog.json";
  }
  parsed.hash = "";
  return parsed.toString();
}

export class AppCatalogStore {
  async listSources(): Promise<AppCatalogSource[]> {
    const pool = getPool();
    const result = await pool.query(
      `select id, name, source_type, feed_url, trust_mode, is_enabled, last_sync_at, last_error,
              created_by, created_at, updated_at
         from core.app_catalog_sources
        order by created_at desc`,
    );

    return result.rows.map((row) => mapSourceRow(row));
  }

  async getSource(id: string): Promise<AppCatalogSource | null> {
    const pool = getPool();
    const result = await pool.query(
      `select id, name, source_type, feed_url, trust_mode, is_enabled, last_sync_at, last_error,
              created_by, created_at, updated_at
         from core.app_catalog_sources
        where id = $1`,
      [id],
    );

    return result.rowCount ? mapSourceRow(result.rows[0]) : null;
  }

  async createFeedSource(input: CreateCatalogSourceInput): Promise<AppCatalogSource> {
    const pool = getPool();
    const feedUrl = normalizeFeedUrl(input.feedUrl);
    const result = await pool.query(
      `insert into core.app_catalog_sources (name, source_type, feed_url, trust_mode, created_by)
       values ($1, 'feed', $2, $3, $4)
       on conflict (feed_url)
       do update set
         name = excluded.name,
         trust_mode = excluded.trust_mode,
         is_enabled = true,
         updated_at = now()
       returning id, name, source_type, feed_url, trust_mode, is_enabled, last_sync_at, last_error,
                 created_by, created_at, updated_at`,
      [input.name.trim(), feedUrl, input.trustMode ?? "manual", input.createdBy ?? null],
    );

    return mapSourceRow(result.rows[0]);
  }

  async setSourceEnabled(id: string, isEnabled: boolean): Promise<AppCatalogSource | null> {
    const pool = getPool();
    const result = await pool.query(
      `update core.app_catalog_sources
          set is_enabled = $2,
              updated_at = now()
        where id = $1
        returning id, name, source_type, feed_url, trust_mode, is_enabled, last_sync_at, last_error,
                  created_by, created_at, updated_at`,
      [id, isEnabled],
    );

    return result.rowCount ? mapSourceRow(result.rows[0]) : null;
  }

  async markSourceSync(id: string, error: string | null): Promise<void> {
    const pool = getPool();
    await pool.query(
      `update core.app_catalog_sources
          set last_sync_at = now(),
              last_error = $2,
              updated_at = now()
        where id = $1`,
      [id, error],
    );
  }

  async listEntries(): Promise<AppCatalogEntry[]> {
    const pool = getPool();
    const result = await pool.query(
      `select app_id, source_id, source_type, trust_status, author_id, namespace, slug, app_name,
              app_version, summary, base_url, manifest_url, manifest_hash, manifest_version,
              license_required, license_issuer_url, metadata_json, deployment_json, created_by, fetched_at,
              created_at, updated_at
         from core.app_catalog_entries
        order by app_name asc, app_id asc`,
    );

    return result.rows.map((row) => mapRow(row));
  }

  async getEntry(appId: string): Promise<AppCatalogEntry | null> {
    const pool = getPool();
    const result = await pool.query(
      `select app_id, source_id, source_type, trust_status, author_id, namespace, slug, app_name,
              app_version, summary, base_url, manifest_url, manifest_hash, manifest_version,
              license_required, license_issuer_url, metadata_json, deployment_json, created_by, fetched_at,
              created_at, updated_at
         from core.app_catalog_entries
        where app_id = $1`,
      [appId],
    );

    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async upsertFromManifest(input: UpsertCatalogEntryInput): Promise<AppCatalogEntry> {
    const pool = getPool();
    const metadata = readManifestMetadata(input.fetched);
    const namespace = readNamespace(metadata.appId);

    const result = await pool.query(
      `insert into core.app_catalog_entries (
         app_id,
         source_id,
         source_type,
         trust_status,
         author_id,
         namespace,
         slug,
         app_name,
         app_version,
         summary,
         base_url,
         manifest_url,
         manifest_hash,
         manifest_version,
         license_required,
         license_issuer_url,
         metadata_json,
         deployment_json,
         created_by,
         fetched_at,
         updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb, $19, $20::timestamptz, now())
       on conflict (app_id)
       do update set
         source_id = excluded.source_id,
         source_type = excluded.source_type,
         trust_status = excluded.trust_status,
         author_id = excluded.author_id,
         namespace = excluded.namespace,
         slug = excluded.slug,
         app_name = excluded.app_name,
         app_version = excluded.app_version,
         summary = excluded.summary,
         base_url = excluded.base_url,
         manifest_url = excluded.manifest_url,
         manifest_hash = excluded.manifest_hash,
         manifest_version = excluded.manifest_version,
         license_required = excluded.license_required,
         license_issuer_url = excluded.license_issuer_url,
         metadata_json = excluded.metadata_json,
         deployment_json = excluded.deployment_json,
         fetched_at = excluded.fetched_at,
         updated_at = now()
       returning app_id, source_id, source_type, trust_status, author_id, namespace, slug, app_name,
                 app_version, summary, base_url, manifest_url, manifest_hash, manifest_version,
                 license_required, license_issuer_url, metadata_json, deployment_json, created_by, fetched_at,
                 created_at, updated_at`,
      [
        metadata.appId,
        input.sourceId ?? null,
        input.sourceType ?? "manual",
        input.trustStatus ?? "manual",
        input.authorId ?? null,
        namespace,
        metadata.slug,
        metadata.appName,
        input.fetched.appVersion,
        input.summary ?? null,
        input.fetched.normalizedBaseUrl,
        input.fetched.fetchedFromUrl,
        input.fetched.manifestHash,
        input.fetched.manifestVersion,
        metadata.licenseRequired,
        metadata.licenseIssuerUrl,
        JSON.stringify({
          manifest: input.fetched.manifest,
          ...(input.metadata ?? {}),
        }),
        JSON.stringify(input.deployment ?? {
          type: "external",
          base_url: input.fetched.normalizedBaseUrl,
        }),
        input.createdBy ?? null,
        input.fetched.fetchedAt,
      ],
    );

    return mapRow(result.rows[0]);
  }

  async deleteEntry(appId: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query("delete from core.app_catalog_entries where app_id = $1", [appId]);
    return (result.rowCount ?? 0) > 0;
  }
}

const store = new AppCatalogStore();

export function getAppCatalogStore() {
  return store;
}
