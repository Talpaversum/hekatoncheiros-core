import { describe, expect, it } from "vitest";

import type { InstalledApp } from "../src/apps/app-installation-store.js";
import { checkAppRuntime, getAppRuntimeHealth } from "../src/apps/app-runtime-health.js";

function app(id: string): InstalledApp {
  return {
    app_id: id,
    slug: id,
    base_url: "http://test-app:4000",
    ui_url: "/plugin.js",
    ui_integrity: "",
    required_privileges: [],
    enabled: true,
    manifest: { runtime: { healthCheck: { path: "/health" } } },
  };
}

describe("application runtime health", () => {
  it("accepts healthy and degraded responses", async () => {
    const healthy = await checkAppRuntime(app("health-ok"), {
      timeoutMs: 100,
      failureThreshold: 3,
      fetcher: async () => new Response(JSON.stringify({ status: "healthy" }), { status: 200 }),
    });
    expect(healthy.status).toBe("healthy");
    expect(healthy.last_healthy_at).not.toBeNull();
    const degraded = await checkAppRuntime(app("health-degraded"), {
      timeoutMs: 100,
      failureThreshold: 3,
      fetcher: async () => new Response(JSON.stringify({ status: "degraded" }), { status: 200 }),
    });
    expect(degraded.status).toBe("degraded");
  });

  it("keeps an Inventory database failure degraded on HTTP 503", async () => {
    const degraded = await checkAppRuntime(app("inventory-db-failed"), {
      timeoutMs: 100,
      failureThreshold: 1,
      fetcher: async () =>
        new Response(
          JSON.stringify({ status: "degraded", message: "database health check failed" }),
          { status: 503 },
        ),
    });
    expect(degraded).toMatchObject({
      status: "degraded",
      http_status: 503,
      reported_status: "degraded",
      error_code: "health_degraded",
      error_message: "database health check failed",
    });
  });

  it("uses a failure threshold and recovers after success", async () => {
    const target = app("health-hysteresis");
    const failed = async () => {
      throw new Error("connect ECONNREFUSED http://secret.internal");
    };
    expect(
      (await checkAppRuntime(target, { timeoutMs: 100, failureThreshold: 2, fetcher: failed }))
        .status,
    ).toBe("unknown");
    const unreachable = await checkAppRuntime(target, {
      timeoutMs: 100,
      failureThreshold: 2,
      fetcher: failed,
    });
    expect(unreachable.status).toBe("unreachable");
    expect(unreachable.error_code).toBe("connection_refused");
    const recovered = await checkAppRuntime(target, {
      timeoutMs: 100,
      failureThreshold: 2,
      fetcher: async () => new Response(JSON.stringify({ status: "healthy" })),
    });
    expect(recovered.status).toBe("healthy");
    expect(recovered.consecutive_failures).toBe(0);
  });

  it("rejects invalid health JSON without exposing its contents", async () => {
    const target = app("health-invalid");
    await checkAppRuntime(target, {
      timeoutMs: 100,
      failureThreshold: 1,
      fetcher: async () => new Response("not-json"),
    });
    expect(getAppRuntimeHealth(target.app_id)).toMatchObject({
      status: "unreachable",
      error_code: "invalid_response",
    });
  });
});
