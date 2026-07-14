import { z } from "zod";

import type { EnvConfig } from "../config/index.js";
import { getPool } from "../db/pool.js";

import {
  type AppCatalogEntry,
  type AppCatalogSource,
  getAppCatalogStore,
} from "./app-catalog-store.js";
import { verifyAuthorUpdateSignal } from "./app-update-signal-verifier.js";
import { assertPublicOrigin, fetchManifest } from "./manifest-fetcher.js";

const MAX_FEED_BYTES = 512_000;
const FETCH_TIMEOUT_MS = 8_000;

const deploymentSchema = z.record(z.string(), z.unknown()).optional();

const feedItemSchema = z.object({
  app_id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  version: z.string().trim().min(1).optional(),
  manifest_url: z.string().url(),
  base_url: z.string().url().optional(),
  manifest_sha256: z.string().trim().regex(/^[a-f0-9]{64}$/i).optional(),
  author_id: z.string().trim().min(1).optional(),
  author_namespace: z.string().trim().min(1).optional(),
  summary: z.string().trim().max(500).optional().nullable(),
  license_required: z.boolean().optional(),
  license_issuer_url: z.string().url().optional().nullable(),
  deployment: deploymentSchema,
  update_signal_jws: z.string().trim().min(1).optional(),
  author_cert_jws: z.string().trim().min(1).optional(),
});

const feedSchema = z.object({
  catalog_version: z.literal(1),
  publisher: z.record(z.string(), z.unknown()).optional(),
  items: z.array(feedItemSchema).max(200),
});

type CatalogFeed = z.infer<typeof feedSchema>;
type CatalogFeedItem = z.infer<typeof feedItemSchema>;

export type SyncCatalogFeedResult = {
  source: AppCatalogSource;
  feed_url: string;
  fetched_at: string;
  total: number;
  imported: number;
  skipped: number;
  errors: Array<{ manifest_url: string; message: string }>;
  items: AppCatalogEntry[];
};

function trustStatusFromSource(source: AppCatalogSource): AppCatalogEntry["trust_status"] {
  if (source.trust_mode === "dev") {
    return "dev";
  }
  if (source.trust_mode === "verified") {
    return "verified";
  }
  if (source.trust_mode === "official") {
    return "official";
  }
  return "unverified";
}

function deriveBaseUrl(item: CatalogFeedItem): string {
  if (item.base_url) {
    return item.base_url;
  }
  return new URL(item.manifest_url).origin;
}

async function readJsonWithLimit(response: Response): Promise<unknown> {
  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    total += result.value.byteLength;
    if (total > MAX_FEED_BYTES) {
      throw new Error(`Catalog feed exceeds size limit (${MAX_FEED_BYTES} bytes)`);
    }
    chunks.push(result.value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const raw = new TextDecoder().decode(merged);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Catalog feed response is not valid JSON");
  }
}

async function fetchCatalogFeed(
  feedUrl: string,
  isTrustedOrigin: (origin: string) => boolean | Promise<boolean>,
): Promise<CatalogFeed> {
  const url = new URL(feedUrl);
  const trusted = await isTrustedOrigin(url.origin);
  if (url.protocol !== "https:" && !trusted) {
    throw new Error("feed_url must use https");
  }

  if (!trusted) {
    await assertPublicOrigin(url);
  }

  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      accept: "application/json",
    },
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error("Catalog feed redirect is not supported, use the target URL directly");
  }

  if (response.status !== 200) {
    throw new Error(`Catalog feed fetch failed (${response.status})`);
  }

  return feedSchema.parse(await readJsonWithLimit(response));
}

export async function syncCatalogFeedSource({
  source,
  actorUserId,
  config,
  isTrustedOrigin,
}: {
  source: AppCatalogSource;
  actorUserId: string;
  config: EnvConfig;
  isTrustedOrigin: (origin: string) => boolean | Promise<boolean>;
}): Promise<SyncCatalogFeedResult> {
  if (source.source_type !== "feed" || !source.feed_url) {
    throw new Error("Catalog source is not a feed");
  }
  if (!source.is_enabled) {
    throw new Error("Catalog source is disabled");
  }

  const store = getAppCatalogStore();
  const importedItems: AppCatalogEntry[] = [];
  const errors: SyncCatalogFeedResult["errors"] = [];
  let feed: CatalogFeed;

  try {
    feed = await fetchCatalogFeed(source.feed_url, isTrustedOrigin);
  } catch (error) {
    const message = (error as Error).message;
    await store.markSourceSync(source.id, message);
    throw error;
  }

  for (const item of feed.items) {
    try {
      const fetched = await fetchManifest(deriveBaseUrl(item), { isTrustedOrigin });
      if (item.manifest_sha256 && fetched.manifestHash.toLowerCase() !== item.manifest_sha256.toLowerCase()) {
        throw new Error("Manifest hash does not match feed manifest_sha256");
      }
      if (item.app_id && fetched.manifest["app_id"] !== item.app_id) {
        throw new Error("Manifest app_id does not match feed app_id");
      }
      if (item.version && fetched.appVersion !== item.version) {
        throw new Error("Manifest version does not match feed version");
      }

      if (Boolean(item.update_signal_jws) !== Boolean(item.author_cert_jws)) {
        throw new Error("Feed update signal requires update_signal_jws and author_cert_jws");
      }
      if (item.update_signal_jws && item.author_cert_jws) {
        const signal = await verifyAuthorUpdateSignal({
          updateSignalJws: item.update_signal_jws,
          authorCertJws: item.author_cert_jws,
          config,
        });
        if (
          signal.app_id !== fetched.manifest["app_id"] ||
          signal.app_version !== fetched.appVersion ||
          signal.manifest_sha256 !== fetched.manifestHash.toLowerCase() ||
          signal.manifest_url !== new URL(fetched.fetchedFromUrl).toString()
        ) {
          throw new Error("Signed update signal does not match the fetched manifest");
        }
        if (item.author_id && item.author_id !== signal.author_id) {
          throw new Error("Signed update signal author does not match feed author_id");
        }

        await getPool().query(
          `insert into core.app_update_signals (
             app_id, source, reported_app_version, reported_manifest_hash,
             reported_manifest_url, reported_at, cleared_at, signature_jws,
             author_cert_jws, verified_author_id, signature_expires_at
           )
           select $1, 'feed', $2, $3, $4, now(), null, $5, $6, $7, $8::timestamptz
           where exists (select 1 from core.installed_apps where app_id = $1)
           on conflict (app_id) do update set
             source = 'feed',
             reported_app_version = excluded.reported_app_version,
             reported_manifest_hash = excluded.reported_manifest_hash,
             reported_manifest_url = excluded.reported_manifest_url,
             reported_at = now(),
             cleared_at = null,
             signature_jws = excluded.signature_jws,
             author_cert_jws = excluded.author_cert_jws,
             verified_author_id = excluded.verified_author_id,
             signature_expires_at = excluded.signature_expires_at`,
          [
            signal.app_id,
            signal.app_version,
            signal.manifest_sha256,
            signal.manifest_url,
            item.update_signal_jws,
            item.author_cert_jws,
            signal.author_id,
            signal.expires_at,
          ],
        );
      }

      const entry = await store.upsertFromManifest({
        fetched,
        sourceId: source.id,
        sourceType: "feed",
        trustStatus: trustStatusFromSource(source),
        authorId: item.author_id ?? null,
        summary: item.summary ?? null,
        metadata: {
          feed: {
            publisher: feed.publisher ?? null,
            item,
          },
        },
        deployment: item.deployment ?? {
          type: "external",
          base_url: fetched.normalizedBaseUrl,
        },
        createdBy: actorUserId,
      });
      importedItems.push(entry);
    } catch (error) {
      errors.push({
        manifest_url: item.manifest_url,
        message: (error as Error).message,
      });
    }
  }

  await store.markSourceSync(source.id, errors.length > 0 ? `${errors.length} item(s) failed` : null);

  return {
    source,
    feed_url: source.feed_url,
    fetched_at: new Date().toISOString(),
    total: feed.items.length,
    imported: importedItems.length,
    skipped: errors.length,
    errors,
    items: importedItems,
  };
}
