import type { FetchManifestResult } from "./manifest-fetcher.js";
import { getPool } from "../db/pool.js";

type CatalogMetadata = Record<string, unknown>;

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
  summary?: string | null;
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
    created_by: (row["created_by"] as string | null) ?? null,
    fetched_at: new Date(String(row["fetched_at"])).toISOString(),
    created_at: new Date(String(row["created_at"])).toISOString(),
    updated_at: new Date(String(row["updated_at"])).toISOString(),
  };
}

export class AppCatalogStore {
  async listEntries(): Promise<AppCatalogEntry[]> {
    const pool = getPool();
    const result = await pool.query(
      `select app_id, source_id, source_type, trust_status, author_id, namespace, slug, app_name,
              app_version, summary, base_url, manifest_url, manifest_hash, manifest_version,
              license_required, license_issuer_url, metadata_json, created_by, fetched_at,
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
              license_required, license_issuer_url, metadata_json, created_by, fetched_at,
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
         created_by,
         fetched_at,
         updated_at
       )
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb, $17, $18::timestamptz, now())
       on conflict (app_id)
       do update set
         source_id = excluded.source_id,
         source_type = excluded.source_type,
         trust_status = excluded.trust_status,
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
         fetched_at = excluded.fetched_at,
         updated_at = now()
       returning app_id, source_id, source_type, trust_status, author_id, namespace, slug, app_name,
                 app_version, summary, base_url, manifest_url, manifest_hash, manifest_version,
                 license_required, license_issuer_url, metadata_json, created_by, fetched_at,
                 created_at, updated_at`,
      [
        metadata.appId,
        input.sourceId ?? null,
        input.sourceType ?? "manual",
        input.trustStatus ?? "manual",
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
