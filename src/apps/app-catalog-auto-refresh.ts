import type { FastifyInstance } from "fastify";

import { recordAudit } from "../audit/audit-service.js";
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

export type AutomaticRefreshEffects = {
  catalog_metadata: boolean;
  update_signals: boolean;
  installed_ui_artifact: boolean;
  runtime: boolean;
};

export const CATALOG_ONLY_AUTO_REFRESH_EFFECTS: AutomaticRefreshEffects = {
  catalog_metadata: true,
  update_signals: true,
  installed_ui_artifact: false,
  runtime: false,
};

export function assertAutomaticRefreshPolicy(
  source: AppCatalogSource,
  effects: AutomaticRefreshEffects,
): void {
  if (!isAutoRefreshEligible(source)) {
    throw new Error("Catalog source is not eligible for automatic refresh");
  }
  if (effects.installed_ui_artifact || effects.runtime) {
    throw new Error(
      "Automatic refresh must not change installed UI artifacts or application runtimes",
    );
  }
  if (!effects.catalog_metadata && !effects.update_signals) {
    throw new Error("Automatic refresh has no permitted effect");
  }
}

export async function runCatalogAutoRefresh(app: FastifyInstance): Promise<void> {
  const sources = (await getAppCatalogStore().listSources()).filter(isAutoRefreshEligible);
  const enabledOrigins = await getTrustedOriginsStore().listEnabledOrigins();

  for (const source of sources) {
    try {
      assertAutomaticRefreshPolicy(source, CATALOG_ONLY_AUTO_REFRESH_EFFECTS);
      const result = await syncCatalogFeedSource({
        source,
        actorUserId: "system:catalog-auto-refresh",
        config: app.config,
        isTrustedOrigin: (origin) => enabledOrigins.has(origin),
      });
      await recordAudit({
        tenantId: app.config.DEFAULT_TENANT_ID,
        actorUserId: null,
        effectiveUserId: null,
        action: "platform.apps.catalog.auto_refresh.complete",
        objectRef: source.id,
        metadata: {
          source_id: source.id,
          trust_mode: source.trust_mode,
          imported: result.imported,
          skipped: result.skipped,
          effects: CATALOG_ONLY_AUTO_REFRESH_EFFECTS,
        },
      });
      app.log.info({
        action: "apps.catalog.auto_refresh.complete",
        source_id: source.id,
        imported: result.imported,
        skipped: result.skipped,
      });
    } catch (error) {
      try {
        await recordAudit({
          tenantId: app.config.DEFAULT_TENANT_ID,
          actorUserId: null,
          effectiveUserId: null,
          action: "platform.apps.catalog.auto_refresh.failed",
          objectRef: source.id,
          metadata: {
            source_id: source.id,
            trust_mode: source.trust_mode,
            error: (error as Error).message,
            effects: CATALOG_ONLY_AUTO_REFRESH_EFFECTS,
          },
        });
      } catch (auditError) {
        app.log.error({
          action: "apps.catalog.auto_refresh.audit_failed",
          source_id: source.id,
          error: (auditError as Error).message,
        });
      }
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
