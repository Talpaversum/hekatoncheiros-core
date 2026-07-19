import type { AppRuntimeStatus } from "./app-runtime-health.js";

export type InstallationStatus = "installed" | "disabled" | "installing" | "updating" | "failed";
export type LicenseStatus =
  | "not_required"
  | "active"
  | "missing"
  | "expired"
  | "revoked"
  | "invalid";
export type UiIntegrationStatus = "ready" | "missing" | "invalid" | "unreachable";
export type RuntimeManagementStatus =
  | "external"
  | "managed_running"
  | "managed_stopped"
  | "managed_failed";
export type Availability = "available" | "degraded" | "blocked" | "unavailable" | "disabled";
export type AvailabilityReason =
  | "runtime_unreachable"
  | "runtime_degraded"
  | "runtime_stopped"
  | "license_missing"
  | "license_expired"
  | "license_revoked"
  | "ui_missing"
  | "ui_unreachable"
  | "application_disabled"
  | "installation_failed"
  | null;

export type AppAvailability = {
  availability: Availability;
  availability_reason: AvailabilityReason;
};

export function computeAppAvailability(input: {
  installationStatus: InstallationStatus;
  runtimeHealth: AppRuntimeStatus;
  licenseStatus: LicenseStatus;
  uiStatus: UiIntegrationStatus;
}): AppAvailability {
  if (input.installationStatus === "disabled")
    return { availability: "disabled", availability_reason: "application_disabled" };
  if (input.installationStatus === "failed")
    return { availability: "unavailable", availability_reason: "installation_failed" };
  if (input.licenseStatus === "missing" || input.licenseStatus === "invalid")
    return { availability: "blocked", availability_reason: "license_missing" };
  if (input.licenseStatus === "expired")
    return { availability: "blocked", availability_reason: "license_expired" };
  if (input.licenseStatus === "revoked")
    return { availability: "blocked", availability_reason: "license_revoked" };
  if (input.runtimeHealth === "stopped")
    return { availability: "unavailable", availability_reason: "runtime_stopped" };
  if (input.runtimeHealth === "unreachable" || input.runtimeHealth === "unknown")
    return { availability: "unavailable", availability_reason: "runtime_unreachable" };
  if (input.uiStatus === "missing" || input.uiStatus === "invalid")
    return { availability: "unavailable", availability_reason: "ui_missing" };
  if (input.uiStatus === "unreachable")
    return { availability: "unavailable", availability_reason: "ui_unreachable" };
  if (input.runtimeHealth === "degraded")
    return { availability: "degraded", availability_reason: "runtime_degraded" };
  return { availability: "available", availability_reason: null };
}
