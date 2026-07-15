import type { FastifyInstance } from "fastify";

import { getPool } from "../db/pool.js";

import { getAppInstallationStore } from "./app-installation-service.js";
import type { InstalledApp } from "./app-installation-store.js";

export type AppRuntimeStatus = "unknown" | "starting" | "healthy" | "degraded" | "unreachable" | "stopped";
export type AppRuntimeHealth = { status: AppRuntimeStatus; last_checked_at: string | null; last_healthy_at: string | null; status_changed_at: string; consecutive_failures: number; message: string | null };

const states = new Map<string, AppRuntimeHealth>();
const initial = (): AppRuntimeHealth => ({ status: "unknown", last_checked_at: null, last_healthy_at: null, status_changed_at: new Date().toISOString(), consecutive_failures: 0, message: null });
export function getAppRuntimeHealth(appId: string) { return states.get(appId) ?? initial(); }

function healthPath(app: InstalledApp) {
  const runtime = (app.manifest as Record<string, unknown>)["runtime"] as { healthCheck?: { path?: string } } | undefined;
  const path = runtime?.healthCheck?.path;
  return typeof path === "string" && path.startsWith("/") ? path : "/health";
}

export async function checkAppRuntime(app: InstalledApp, options: { timeoutMs: number; failureThreshold: number; fetcher?: typeof fetch }): Promise<AppRuntimeHealth> {
  const previous = getAppRuntimeHealth(app.app_id); const checkedAt = new Date().toISOString();
  try {
    const response = await (options.fetcher ?? fetch)(new URL(healthPath(app), app.base_url), { signal: AbortSignal.timeout(options.timeoutMs) });
    if (!response.ok) throw new Error(`health_http_${response.status}`);
    const body = await response.json() as { status?: unknown };
    if (body.status !== "healthy" && body.status !== "degraded" && body.status !== "ok") throw new Error("invalid_health_response");
    const status: AppRuntimeStatus = body.status === "degraded" ? "degraded" : "healthy";
    const next = { status, last_checked_at: checkedAt, last_healthy_at: status === "healthy" ? checkedAt : previous.last_healthy_at, status_changed_at: previous.status === status ? previous.status_changed_at : checkedAt, consecutive_failures: 0, message: status === "degraded" ? "Application reports degraded service" : null };
    states.set(app.app_id, next); return next;
  } catch {
    const failures = previous.consecutive_failures + 1;
    const status: AppRuntimeStatus = failures >= options.failureThreshold ? "unreachable" : previous.status;
    const next = { ...previous, status, last_checked_at: checkedAt, status_changed_at: previous.status === status ? previous.status_changed_at : checkedAt, consecutive_failures: failures, message: status === "unreachable" ? "Application health check failed" : previous.message };
    states.set(app.app_id, next); return next;
  }
}

export function registerAppRuntimeHealthMonitor(app: FastifyInstance) {
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const settings = async () => {
    try { const result = await getPool().query("select runtime_health_interval_ms, runtime_health_timeout_ms, runtime_health_failure_threshold from core.platform_instance limit 1"); const row = result.rows[0]; return { intervalMs: Number(row?.runtime_health_interval_ms ?? app.config.APP_RUNTIME_HEALTH_INTERVAL_MS), timeoutMs: Number(row?.runtime_health_timeout_ms ?? app.config.APP_RUNTIME_HEALTH_TIMEOUT_MS), failureThreshold: Number(row?.runtime_health_failure_threshold ?? app.config.APP_RUNTIME_HEALTH_FAILURE_THRESHOLD) }; }
    catch { return { intervalMs: app.config.APP_RUNTIME_HEALTH_INTERVAL_MS, timeoutMs: app.config.APP_RUNTIME_HEALTH_TIMEOUT_MS, failureThreshold: app.config.APP_RUNTIME_HEALTH_FAILURE_THRESHOLD }; }
  };
  const tick = async () => {
    if (running) return; running = true;
    try {
      const policy = await settings();
      const installed = (await getAppInstallationStore().listInstalledApps()).filter((item) => item.enabled !== false);
      await Promise.all(installed.map(async (item) => {
        const before = getAppRuntimeHealth(item.app_id);
        const after = await checkAppRuntime(item, { timeoutMs: policy.timeoutMs, failureThreshold: policy.failureThreshold });
        if (before.status !== after.status) app.log.info({ event: "application.runtime_status_changed", appId: item.app_id, previousStatus: before.status, newStatus: after.status, checkedAt: after.last_checked_at, consecutiveFailures: after.consecutive_failures });
      }));
      timer = setTimeout(() => void tick(), policy.intervalMs); timer.unref();
    } finally { running = false; }
  };
  app.addHook("onReady", () => void tick()); app.addHook("onClose", async () => { if (timer) clearTimeout(timer); });
}
