import { describe, expect, it } from "vitest";

import { computeAppAvailability } from "../src/apps/app-availability.js";
import { diagnoseBaseUrl } from "../src/apps/app-diagnostics.js";

const available = {
  installationStatus: "installed",
  runtimeHealth: "healthy",
  licenseStatus: "active",
  uiStatus: "ready",
} as const;

describe("application availability", () => {
  it("keeps runtime, license and UI outcomes independent", () => {
    expect(computeAppAvailability(available)).toEqual({
      availability: "available",
      availability_reason: null,
    });
    expect(computeAppAvailability({ ...available, licenseStatus: "missing" })).toEqual({
      availability: "blocked",
      availability_reason: "license_missing",
    });
    expect(computeAppAvailability({ ...available, runtimeHealth: "unreachable" })).toEqual({
      availability: "unavailable",
      availability_reason: "runtime_unreachable",
    });
    expect(computeAppAvailability({ ...available, runtimeHealth: "degraded" })).toEqual({
      availability: "degraded",
      availability_reason: "runtime_degraded",
    });
    expect(computeAppAvailability({ ...available, uiStatus: "missing" })).toEqual({
      availability: "unavailable",
      availability_reason: "ui_missing",
    });
  });

  it("diagnoses a container-local localhost base URL", () => {
    expect(diagnoseBaseUrl("http://localhost:4010")).toMatchObject({
      status: "failed",
      error_code: "localhost_misconfiguration",
    });
    expect(diagnoseBaseUrl("http://inventory:4010")).toBeNull();
  });
});
