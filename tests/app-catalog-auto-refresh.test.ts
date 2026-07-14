import { describe, expect, it } from "vitest";

import {
  assertAutomaticRefreshPolicy,
  CATALOG_ONLY_AUTO_REFRESH_EFFECTS,
  isAutoRefreshEligible,
} from "../src/apps/app-catalog-auto-refresh.js";
import type { AppCatalogSource } from "../src/apps/app-catalog-store.js";

function source(overrides: Partial<AppCatalogSource>): AppCatalogSource {
  return {
    id: "source-1",
    name: "Official catalog",
    source_type: "feed",
    feed_url: "https://catalog.example/.well-known/hc/app-catalog.json",
    trust_mode: "official",
    is_enabled: true,
    auto_refresh_enabled: true,
    last_sync_at: null,
    last_error: null,
    created_by: "usr_admin",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

describe("catalog automatic refresh policy", () => {
  it("requires global candidates to be enabled, opted in, and verified or official", () => {
    expect(isAutoRefreshEligible(source({ trust_mode: "verified" }))).toBe(true);
    expect(isAutoRefreshEligible(source({ trust_mode: "official" }))).toBe(true);
    expect(isAutoRefreshEligible(source({ trust_mode: "manual" }))).toBe(false);
    expect(isAutoRefreshEligible(source({ auto_refresh_enabled: false }))).toBe(false);
    expect(isAutoRefreshEligible(source({ is_enabled: false }))).toBe(false);
  });

  it("allows catalog-only effects and rejects automatic UI or runtime mutation", () => {
    const eligible = source({});
    expect(() =>
      assertAutomaticRefreshPolicy(eligible, CATALOG_ONLY_AUTO_REFRESH_EFFECTS),
    ).not.toThrow();
    expect(() =>
      assertAutomaticRefreshPolicy(eligible, {
        ...CATALOG_ONLY_AUTO_REFRESH_EFFECTS,
        installed_ui_artifact: true,
      }),
    ).toThrow("must not change installed UI artifacts");
    expect(() =>
      assertAutomaticRefreshPolicy(eligible, {
        ...CATALOG_ONLY_AUTO_REFRESH_EFFECTS,
        runtime: true,
      }),
    ).toThrow("must not change installed UI artifacts");
  });
});
