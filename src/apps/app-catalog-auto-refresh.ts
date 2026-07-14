import type { FastifyInstance } from "fastify";

import { getTrustedOriginsStore } from "../platform/trusted-origins-store.js";

import { syncCatalogFeedSource } from "./app-catalog-feed-sync.js";
import {
  getAppCatalogStore,
  type AppCatalogSource,
} from "./app-catalog-store.js";

export function isAutoRefreshEligible(source: AppCatalogSource): boolean {
  return (
    source.source_type === "feed" &&
    source.is_enabled &&
    source.auto_refresh_enabled &&
    (source.trust_mode === "verified" || source.trust_mode === "official")
  );
}

export async function runCatalogAutoRefresh(app: FastifyInstance): Promise<void> {
  const sources = (await getAppCatalogStore().listSources()).filter(isAutoRefreshEligible);
  const enabledOrigins = await getTrustedOriginsStore().listEnabledOrigins();

  for (const source of sources) {
    try {
      const result = await syncCatalogFeedSource({
        source,
        actorUserId: "system:catalog-auto-refresh",
        config: app.config,
        isTrustedOrigin: (origin) => enabledOrigins.has(origin),
      });
      app.log.info({
        action: "apps.catalog.auto_refresh.complete",
        source_id: source.id,
        imported: result.imported,
        skipped: result.skipped,
      });
    } catch (error) {
      app.log.warn({
        action: "apps.catalog.auto_refresh.failed",
        source_id: source.id,
        error: (error as Error).message,
      });
    }
  }
}

export function registerCatalogAutoRefresh(app: FastifyInstance): void {
  if (!app.config.APP_CATALOG_AUTO_REFRESH_ENABLED) {
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await runCatalogAutoRefresh(app);
    } finally {
      running = false;
    }
  };

  const interval = setInterval(
    () => void tick(),
    app.config.APP_CATALOG_AUTO_REFRESH_INTERVAL_SECONDS * 1000,
  );
  interval.unref();
  app.addHook("onReady", () => void tick());
  app.addHook("onClose", async () => clearInterval(interval));
}
