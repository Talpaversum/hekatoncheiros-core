import type { FastifyInstance } from "fastify";

import { getPool } from "../db/pool.js";

import { getAppInstallationStore } from "./app-installation-service.js";
import type { InstalledApp } from "./app-installation-store.js";

export type AppRuntimeStatus = "unknown" | "healthy" | "degraded" | "unreachable" | "stopped";
export type AppHealthErrorCode =
  | "dns_failed"
  | "connection_refused"
  | "connection_timeout"
  | "tls_error"
  | "invalid_response"
  | "http_error"
  | "health_degraded"
  | "health_endpoint_missing";

export type AppRuntimeHealth = {
  status: AppRuntimeStatus;
  checked_at: string | null;
  last_checked_at: string | null;
  url: string | null;
  http_status: number | null;
  reported_status: string | null;
  latency_ms: number | null;
  error_code: AppHealthErrorCode | null;
  error_message: string | null;
  last_healthy_at: string | null;
  status_changed_at: string;
  consecutive_failures: number;
  message: string | null;
};

const states = new Map<string, AppRuntimeHealth>();
const initial = (): AppRuntimeHealth => ({
  status: "unknown",
  checked_at: null,
  last_checked_at: null,
  url: null,
  http_status: null,
  reported_status: null,
  latency_ms: null,
  error_code: null,
  error_message: null,
  last_healthy_at: null,
  status_changed_at: new Date().toISOString(),
  consecutive_failures: 0,
  message: null,
});

export function getAppRuntimeHealth(appId: string) {
  return states.get(appId) ?? initial();
}

export function markAppRuntimeStopped(appId: string): AppRuntimeHealth {
  const previous = getAppRuntimeHealth(appId);
  const checkedAt = new Date().toISOString();
  const next = {
    ...previous,
    status: "stopped" as const,
    checked_at: checkedAt,
    last_checked_at: checkedAt,
    status_changed_at: previous.status === "stopped" ? previous.status_changed_at : checkedAt,
    error_code: null,
    error_message: null,
    message: null,
  };
  states.set(appId, next);
  return next;
}

function healthPath(app: InstalledApp) {
  const path = app.manifest.runtime?.healthCheck?.path;
  return typeof path === "string" && path.startsWith("/") ? path : "/health";
}

export function getAppHealthUrl(app: InstalledApp) {
  return new URL(healthPath(app), app.base_url).toString();
}

function classifyError(error: unknown): { code: AppHealthErrorCode; message: string } {
  const raw =
    error instanceof Error
      ? `${error.name} ${error.message} ${(error.cause as Error | undefined)?.message ?? ""}`
      : String(error);
  const value = raw.toLowerCase();
  if (value.includes("enotfound") || value.includes("eai_again") || value.includes("getaddrinfo"))
    return { code: "dns_failed", message: "Core cannot resolve the application hostname" };
  if (value.includes("econnrefused") || value.includes("connection refused"))
    return { code: "connection_refused", message: "The application refused the connection" };
  if (value.includes("timeout") || value.includes("abort"))
    return { code: "connection_timeout", message: "The application health check timed out" };
  if (value.includes("tls") || value.includes("certificate") || value.includes("ssl"))
    return { code: "tls_error", message: "TLS validation failed" };
  return {
    code: "invalid_response",
    message: "The application returned an invalid health response",
  };
}

export async function checkAppRuntime(
  app: InstalledApp,
  options: { timeoutMs: number; failureThreshold: number; fetcher?: typeof fetch },
): Promise<AppRuntimeHealth> {
  const previous = getAppRuntimeHealth(app.app_id);
  const checkedAt = new Date().toISOString();
  const url = getAppHealthUrl(app);
  const startedAt = performance.now();
  let httpStatus: number | null = null;
  let reportedStatus: string | null = null;

  try {
    const response = await (options.fetcher ?? fetch)(url, {
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    httpStatus = response.status;
    let body: { status?: unknown; message?: unknown };
    try {
      body = (await response.json()) as { status?: unknown; message?: unknown };
    } catch {
      throw Object.assign(new Error("invalid health response"), { healthCode: "invalid_response" });
    }
    reportedStatus = typeof body.status === "string" ? body.status : null;
    if (reportedStatus === "degraded") {
      const errorMessage =
        typeof body.message === "string" ? body.message : "Application reports degraded service";
      const next: AppRuntimeHealth = {
        status: "degraded",
        checked_at: checkedAt,
        last_checked_at: checkedAt,
        url,
        http_status: httpStatus,
        reported_status: reportedStatus,
        latency_ms: Math.round(performance.now() - startedAt),
        error_code: "health_degraded",
        error_message: errorMessage,
        last_healthy_at: previous.last_healthy_at,
        status_changed_at: previous.status === "degraded" ? previous.status_changed_at : checkedAt,
        consecutive_failures: 0,
        message: errorMessage,
      };
      states.set(app.app_id, next);
      return next;
    }
    if (!response.ok) {
      const code: AppHealthErrorCode =
        response.status === 404 ? "health_endpoint_missing" : "http_error";
      throw Object.assign(new Error(`Health endpoint returned HTTP ${response.status}`), {
        healthCode: code,
      });
    }
    if (reportedStatus !== "healthy" && reportedStatus !== "ok") {
      throw Object.assign(new Error("Health response status is invalid"), {
        healthCode: "invalid_response",
      });
    }
    const next: AppRuntimeHealth = {
      status: "healthy",
      checked_at: checkedAt,
      last_checked_at: checkedAt,
      url,
      http_status: httpStatus,
      reported_status: reportedStatus,
      latency_ms: Math.round(performance.now() - startedAt),
      error_code: null,
      error_message: null,
      last_healthy_at: checkedAt,
      status_changed_at: previous.status === "healthy" ? previous.status_changed_at : checkedAt,
      consecutive_failures: 0,
      message: null,
    };
    states.set(app.app_id, next);
    return next;
  } catch (error) {
    const failures = previous.consecutive_failures + 1;
    const status: AppRuntimeStatus =
      failures >= options.failureThreshold ? "unreachable" : previous.status;
    const explicitCode = (error as { healthCode?: AppHealthErrorCode }).healthCode;
    const classified = explicitCode
      ? {
          code: explicitCode,
          message: error instanceof Error ? error.message : "Application health check failed",
        }
      : classifyError(error);
    const next: AppRuntimeHealth = {
      ...previous,
      status,
      checked_at: checkedAt,
      last_checked_at: checkedAt,
      url,
      http_status: httpStatus,
      reported_status: reportedStatus,
      latency_ms: Math.round(performance.now() - startedAt),
      error_code: classified.code,
      error_message: classified.message,
      status_changed_at: previous.status === status ? previous.status_changed_at : checkedAt,
      consecutive_failures: failures,
      message: classified.message,
    };
    states.set(app.app_id, next);
    return next;
  }
}

export async function persistAppRuntimeHealth(appId: string, health: AppRuntimeHealth) {
  try {
    await getPool().query(
      `insert into core.app_runtime_health_results (
       app_id, runtime_health, checked_at, url, http_status, reported_status, latency_ms,
       error_code, error_message, consecutive_failures, last_healthy_at, status_changed_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (app_id) do update set runtime_health=excluded.runtime_health, checked_at=excluded.checked_at,
       url=excluded.url, http_status=excluded.http_status, reported_status=excluded.reported_status,
       latency_ms=excluded.latency_ms, error_code=excluded.error_code, error_message=excluded.error_message,
       consecutive_failures=excluded.consecutive_failures, last_healthy_at=excluded.last_healthy_at,
       status_changed_at=excluded.status_changed_at`,
      [
        appId,
        health.status,
        health.checked_at,
        health.url,
        health.http_status,
        health.reported_status,
        health.latency_ms,
        health.error_code,
        health.error_message,
        health.consecutive_failures,
        health.last_healthy_at,
        health.status_changed_at,
      ],
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "42P01") throw error;
  }
}

export async function loadAppRuntimeHealthResults() {
  let result;
  try {
    result = await getPool().query("select * from core.app_runtime_health_results");
  } catch (error) {
    if ((error as { code?: string }).code === "42P01") return;
    throw error;
  }
  for (const row of result.rows) {
    states.set(String(row.app_id), {
      status: row.runtime_health as AppRuntimeStatus,
      checked_at: row.checked_at ? new Date(row.checked_at).toISOString() : null,
      last_checked_at: row.checked_at ? new Date(row.checked_at).toISOString() : null,
      url: row.url ?? null,
      http_status: row.http_status ?? null,
      reported_status: row.reported_status ?? null,
      latency_ms: row.latency_ms ?? null,
      error_code: row.error_code ?? null,
      error_message: row.error_message ?? null,
      last_healthy_at: row.last_healthy_at ? new Date(row.last_healthy_at).toISOString() : null,
      status_changed_at: new Date(row.status_changed_at).toISOString(),
      consecutive_failures: row.consecutive_failures,
      message: row.error_message ?? null,
    });
  }
}

export function registerAppRuntimeHealthMonitor(app: FastifyInstance) {
  let running = false;
  let timer: NodeJS.Timeout | undefined;
  const settings = async () => {
    try {
      const result = await getPool().query(
        "select runtime_health_interval_ms, runtime_health_timeout_ms, runtime_health_failure_threshold from core.platform_instance limit 1",
      );
      const row = result.rows[0];
      return {
        intervalMs: Number(
          row?.runtime_health_interval_ms ?? app.config.APP_RUNTIME_HEALTH_INTERVAL_MS,
        ),
        timeoutMs: Number(
          row?.runtime_health_timeout_ms ?? app.config.APP_RUNTIME_HEALTH_TIMEOUT_MS,
        ),
        failureThreshold: Number(
          row?.runtime_health_failure_threshold ?? app.config.APP_RUNTIME_HEALTH_FAILURE_THRESHOLD,
        ),
      };
    } catch {
      return {
        intervalMs: app.config.APP_RUNTIME_HEALTH_INTERVAL_MS,
        timeoutMs: app.config.APP_RUNTIME_HEALTH_TIMEOUT_MS,
        failureThreshold: app.config.APP_RUNTIME_HEALTH_FAILURE_THRESHOLD,
      };
    }
  };
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const policy = await settings();
      const installed = (await getAppInstallationStore().listInstalledApps()).filter(
        (item) => item.enabled !== false,
      );
      await Promise.all(
        installed.map(async (item) => {
          const before = getAppRuntimeHealth(item.app_id);
          const after = await checkAppRuntime(item, {
            timeoutMs: policy.timeoutMs,
            failureThreshold: policy.failureThreshold,
          });
          await persistAppRuntimeHealth(item.app_id, after);
          if (before.status !== after.status)
            app.log.info({
              event: "application.runtime_status_changed",
              appId: item.app_id,
              previousStatus: before.status,
              newStatus: after.status,
              checkedAt: after.checked_at,
              consecutiveFailures: after.consecutive_failures,
            });
        }),
      );
      timer = setTimeout(() => void tick(), policy.intervalMs);
      timer.unref();
    } finally {
      running = false;
    }
  };
  app.addHook("onReady", async () => {
    await loadAppRuntimeHealthResults();
    void tick();
  });
  app.addHook("onClose", async () => {
    if (timer) clearTimeout(timer);
  });
}
