import { describe, expect, it, vi } from "vitest";

import {
  AppRuntimeApprovalError,
  assertAppRuntimeStartApproval,
  recordAppRuntimeStartApproval,
} from "../src/apps/app-runtime-approval.js";
import { buildAppRuntimeDeploymentPlan } from "../src/apps/app-runtime-plan.js";

const manifestSha256 = "a".repeat(64);
const packageSha256 = "b".repeat(64);

function approval() {
  return {
    confirmed: true as const,
    expected_manifest_sha256: manifestSha256,
    expected_package_sha256: packageSha256,
    expected_deployment: {
      service_name: "inventory",
      internal_base_url: "http://inventory:4010",
      package_url: "https://apps.example/packages/inventory.tar.gz",
      compose_project: "hekatoncheiros-core",
      compose_file: "docker-compose.app.yml",
    },
  };
}

function composePlan(packageHash: string | null = packageSha256) {
  return buildAppRuntimeDeploymentPlan({
    app_id: "talpaversum/inventory",
    slug: "inventory",
    base_url: "http://inventory:4010",
    deployment: {
      type: "compose",
      service_name: "inventory",
      internal_base_url: "http://inventory:4010",
      package_url: "https://apps.example/packages/inventory.tar.gz",
      package_sha256: packageHash,
      compose_file: "docker-compose.app.yml",
    },
  });
}

function captureApprovalError(callback: () => void): AppRuntimeApprovalError {
  let captured: unknown;
  try {
    callback();
  } catch (error) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(AppRuntimeApprovalError);
  return captured as AppRuntimeApprovalError;
}

describe("Core-managed runtime approval", () => {
  it("accepts approval bound to the current manifest and package", () => {
    expect(() =>
      assertAppRuntimeStartApproval({
        approval: approval(),
        manifestSha256,
        plan: composePlan(),
      }),
    ).not.toThrow();
  });

  it("requires explicit approval", () => {
    const error = captureApprovalError(() =>
      assertAppRuntimeStartApproval({
        manifestSha256,
        plan: composePlan(),
      }),
    );
    expect(error.code).toBe("runtime_approval_required");
  });

  it.each([
    ["manifest", "c".repeat(64), packageSha256],
    ["package", manifestSha256, "d".repeat(64)],
  ])("rejects approval for a stale %s hash", (_field, expectedManifest, expectedPackage) => {
    const error = captureApprovalError(() =>
      assertAppRuntimeStartApproval({
        approval: {
          ...approval(),
          expected_manifest_sha256: expectedManifest,
          expected_package_sha256: expectedPackage,
        },
        manifestSha256,
        plan: composePlan(),
      }),
    );
    expect(error.code).toBe("runtime_approval_stale");
  });

  it("rejects approval for stale deployment metadata", () => {
    const error = captureApprovalError(() =>
      assertAppRuntimeStartApproval({
        approval: {
          ...approval(),
          expected_deployment: {
            ...approval().expected_deployment,
            service_name: "changed-service",
          },
        },
        manifestSha256,
        plan: composePlan(),
      }),
    );
    expect(error.code).toBe("runtime_approval_stale");
  });

  it("rejects runtime start when the catalog does not declare a package hash", () => {
    const error = captureApprovalError(() =>
      assertAppRuntimeStartApproval({
        approval: approval(),
        manifestSha256,
        plan: composePlan(null),
      }),
    );
    expect(error.code).toBe("runtime_approval_stale");
  });

  it("records the approved deployment and actor", async () => {
    const auditWriter = vi.fn().mockResolvedValue(undefined);
    await recordAppRuntimeStartApproval({
      tenantId: "tnt_default",
      actorUserId: "usr_admin",
      effectiveUserId: "usr_admin",
      appVersion: "0.1.0",
      sourceType: "feed",
      trustStatus: "dev",
      manifestSha256,
      plan: composePlan(),
      auditWriter,
    });

    expect(auditWriter).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tnt_default",
        actorUserId: "usr_admin",
        action: "platform.apps.runtime.start.approved",
        objectRef: "talpaversum/inventory",
        metadata: expect.objectContaining({
          manifest_sha256: manifestSha256,
          package_sha256: packageSha256,
          deployment: expect.objectContaining({
            service_name: "inventory",
            compose_file: "docker-compose.app.yml",
          }),
        }),
      }),
    );
  });

  it("fails approval when the audit event cannot be stored", async () => {
    const auditError = new Error("audit unavailable");
    await expect(
      recordAppRuntimeStartApproval({
        tenantId: "tnt_default",
        actorUserId: "usr_admin",
        effectiveUserId: "usr_admin",
        appVersion: "0.1.0",
        sourceType: "feed",
        trustStatus: "dev",
        manifestSha256,
        plan: composePlan(),
        auditWriter: vi.fn().mockRejectedValue(auditError),
      }),
    ).rejects.toBe(auditError);
  });
});
