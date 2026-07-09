import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { stageAppRuntimePackage } from "../src/apps/app-runtime-package-stage.js";
import { buildAppRuntimeDeploymentPlan } from "../src/apps/app-runtime-plan.js";
import type { EnvConfig } from "../src/config/index.js";

function testConfig(coreDataDir: string): EnvConfig {
  return {
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: "postgres://hc_user:hc_password@localhost:5432/hc_core",
    CORE_DATA_DIR: coreDataDir,
    TENANCY_MODE: "row_level",
    JWT_ISSUER: "hekatoncheiros-core",
    JWT_AUDIENCE_USER: "hc-user",
    JWT_AUDIENCE_APP: "hc-app",
    JWT_SECRET: "supersecretkeysupersecret",
    INSTALLER_TOKEN_SECRET: "installersecretinstallersecret",
    INSTALLER_TOKEN_ISSUER: "hekatoncheiros-core-installer",
    DEFAULT_TENANT_ID: "tnt_default",
    LICENSING_CLOCK_SKEW_SECONDS: 600,
    LICENSING_CLOCK_SOFT_GRACE_SECONDS: 43_200,
    OFFLINE_LICENSE_PUBLIC_KEYS_JSON: "{}",
    LICENSING_ROOT_JWKS_JSON: '{"keys":[]}',
    LICENSING_DCR_SIGNING_PRIVATE_JWK_JSON: "",
    LICENSING_DCR_SIGNING_PUBLIC_JWK_JSON: "",
    LICENSING_OAUTH_CALLBACK_BASE_URL: "http://127.0.0.1:3000",
  };
}

function composePlan(overrides?: Record<string, unknown>) {
  return buildAppRuntimeDeploymentPlan({
    app_id: "talpaversum/inventory",
    slug: "inventory",
    base_url: "http://inventory:4010",
    deployment: {
      type: "compose",
      service_name: "inventory",
      internal_base_url: "http://inventory:4010",
      package_url: "https://apps.example/packages/inventory.tar.gz",
      compose_file: "docker-compose.app.yml",
      ...overrides,
    },
  });
}

describe("app runtime package staging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads and stores a runtime package", async () => {
    const content = Buffer.from("compose package");
    const expectedSha = createHash("sha256").update(content).digest("hex");
    const coreDataDir = await mkdtemp(path.join(os.tmpdir(), "hc-runtime-package-"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(content));

    const result = await stageAppRuntimePackage({
      config: testConfig(coreDataDir),
      plan: composePlan({ package_sha256: expectedSha }),
      isTrustedOrigin: () => true,
    });

    expect(result).toMatchObject({
      status: "staged",
      app_id: "talpaversum/inventory",
      package_url: "https://apps.example/packages/inventory.tar.gz",
      package_sha256: expectedSha,
      size_bytes: content.length,
    });
    await expect(readFile(result.package_path)).resolves.toEqual(content);
  });

  it("rejects package hash mismatches", async () => {
    const coreDataDir = await mkdtemp(path.join(os.tmpdir(), "hc-runtime-package-"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("different content"));

    await expect(
      stageAppRuntimePackage({
        config: testConfig(coreDataDir),
        plan: composePlan({ package_sha256: "a".repeat(64) }),
        isTrustedOrigin: () => true,
      }),
    ).rejects.toThrow("Runtime package hash does not match package_sha256");
  });

  it("requires https unless the package origin is trusted", async () => {
    const coreDataDir = await mkdtemp(path.join(os.tmpdir(), "hc-runtime-package-"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("content"));

    await expect(
      stageAppRuntimePackage({
        config: testConfig(coreDataDir),
        plan: composePlan({ package_url: "http://apps.example/packages/inventory.tar.gz" }),
        isTrustedOrigin: () => false,
      }),
    ).rejects.toThrow("package_url must use https unless the origin is trusted");

    await expect(
      stageAppRuntimePackage({
        config: testConfig(coreDataDir),
        plan: composePlan({ package_url: "http://apps.example/packages/inventory.tar.gz" }),
        isTrustedOrigin: () => true,
      }),
    ).resolves.toMatchObject({ status: "staged" });
  });
});
