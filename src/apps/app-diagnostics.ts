import { lookup } from "node:dns/promises";

import type { InstalledApp } from "./app-installation-store.js";
import {
  checkAppRuntime,
  persistAppRuntimeHealth,
  type AppRuntimeHealth,
} from "./app-runtime-health.js";

export type DiagnosticCheck = {
  id: "dns" | "http" | "health" | "manifest" | "ui_artifact" | "license" | "trusted_origin";
  status: "passed" | "failed" | "warning";
  message: string;
  error_code?: string;
};

export function diagnoseBaseUrl(baseUrl: string): DiagnosticCheck | null {
  const hostname = new URL(baseUrl).hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
    return {
      id: "dns",
      status: "failed",
      error_code: "localhost_misconfiguration",
      message:
        "The configured base URL uses localhost. Inside the Core container, localhost refers to Core itself. Configure the application using its Docker network hostname.",
    };
  }
  return null;
}

export async function runAppDiagnostics(input: {
  app: InstalledApp;
  timeoutMs: number;
  failureThreshold: number;
  licenseStatus: string;
  uiStatus: string;
  trustedOrigin: boolean;
  fetcher?: typeof fetch;
  resolver?: typeof lookup;
  persist?: boolean;
}): Promise<{ checked_at: string; runtime_health: AppRuntimeHealth; checks: DiagnosticCheck[] }> {
  const checks: DiagnosticCheck[] = [];
  const baseUrlError = diagnoseBaseUrl(input.app.base_url);
  if (baseUrlError) {
    checks.push(baseUrlError);
  } else {
    try {
      await (input.resolver ?? lookup)(new URL(input.app.base_url).hostname);
      checks.push({
        id: "dns",
        status: "passed",
        message: "Core resolved the application hostname.",
      });
    } catch {
      checks.push({
        id: "dns",
        status: "failed",
        error_code: "dns_failed",
        message:
          "Core cannot resolve the application hostname. Verify that Core and the application share a Docker network.",
      });
    }
  }

  const runtimeHealth = await checkAppRuntime(input.app, {
    timeoutMs: input.timeoutMs,
    failureThreshold: input.failureThreshold,
    fetcher: input.fetcher,
  });
  if (input.persist !== false) await persistAppRuntimeHealth(input.app.app_id, runtimeHealth);
  const connected = runtimeHealth.http_status !== null;
  checks.push({
    id: "http",
    status: connected ? "passed" : "failed",
    error_code: connected ? undefined : (runtimeHealth.error_code ?? undefined),
    message: connected
      ? `Application responded with HTTP ${runtimeHealth.http_status}.`
      : (runtimeHealth.error_message ?? "Core could not connect to the application."),
  });
  checks.push({
    id: "health",
    status:
      runtimeHealth.status === "healthy"
        ? "passed"
        : runtimeHealth.status === "degraded"
          ? "warning"
          : "failed",
    error_code: runtimeHealth.error_code ?? undefined,
    message:
      runtimeHealth.status === "degraded" && runtimeHealth.http_status === 503
        ? "The application responded, but reported degraded health. Check its database and dependent services."
        : (runtimeHealth.error_message ?? "Health endpoint passed."),
  });

  let manifestPassed = false;
  for (const path of ["/.well-known/hc-app-manifest.json", "/manifest.json"]) {
    try {
      const response = await (input.fetcher ?? fetch)(new URL(path, input.app.base_url), {
        signal: AbortSignal.timeout(input.timeoutMs),
      });
      if (response.ok) {
        manifestPassed = true;
        break;
      }
    } catch {
      /* Report the aggregate result without leaking request details. */
    }
  }
  checks.push({
    id: "manifest",
    status: manifestPassed ? "passed" : "failed",
    message: manifestPassed
      ? "Manifest endpoint passed."
      : "Core could not read a valid manifest endpoint.",
  });
  checks.push({
    id: "ui_artifact",
    status: input.uiStatus === "ready" ? "passed" : "failed",
    message:
      input.uiStatus === "ready"
        ? "The stored UI artifact is ready."
        : "The application UI artifact is missing or invalid.",
  });
  checks.push({
    id: "license",
    status:
      input.licenseStatus === "active" || input.licenseStatus === "not_required"
        ? "passed"
        : "failed",
    message:
      input.licenseStatus === "missing"
        ? "The runtime is healthy, but the application requires an active license."
        : `License status: ${input.licenseStatus}.`,
  });
  checks.push({
    id: "trusted_origin",
    status: input.trustedOrigin ? "passed" : "failed",
    message: input.trustedOrigin
      ? "The application origin is trusted."
      : "The application origin is not trusted by Core.",
  });
  return { checked_at: new Date().toISOString(), runtime_health: runtimeHealth, checks };
}
