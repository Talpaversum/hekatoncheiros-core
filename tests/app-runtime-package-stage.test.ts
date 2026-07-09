import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  stageAppRuntimePackage,
  unpackAppRuntimePackage,
} from "../src/apps/app-runtime-package-stage.js";
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
    APP_RUNTIME_DOCKER_ENABLED: false,
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

function octal(value: number, length: number): Buffer {
  const output = Buffer.alloc(length, 0);
  const text = value.toString(8).padStart(length - 1, "0");
  output.write(text, 0, "ascii");
  return output;
}

function tarEntry(name: string, content: string, typeFlag = "0"): Buffer {
  const body = Buffer.from(content);
  const header = Buffer.alloc(512, 0);
  header.write(name, 0, 100, "utf8");
  octal(0o644, 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  octal(typeFlag === "5" ? 0 : body.length, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(" ", 148, 156);
  header.write(typeFlag, 156, 1, "ascii");
  header.write("ustar", 257, 5, "ascii");
  header.write("00", 263, 2, "ascii");

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  octal(checksum, 8).copy(header, 148);

  if (typeFlag === "5") {
    return header;
  }

  const padding = Buffer.alloc((512 - (body.length % 512)) % 512, 0);
  return Buffer.concat([header, body, padding]);
}

function tarGz(entries: Array<{ name: string; content?: string; typeFlag?: string }>): Buffer {
  return gzipSync(
    Buffer.concat([
      ...entries.map((entry) => tarEntry(entry.name, entry.content ?? "", entry.typeFlag ?? "0")),
      Buffer.alloc(1024, 0),
    ]),
  );
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

  it("unpacks a staged package and locates the compose file", async () => {
    const content = tarGz([
      {
        name: "docker-compose.app.yml",
        content: "services:\n  inventory:\n    image: hc-app-inventory:local\n",
      },
      { name: "manifest/app-manifest.json", content: "{}" },
    ]);
    const coreDataDir = await mkdtemp(path.join(os.tmpdir(), "hc-runtime-package-"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(content));

    const plan = composePlan();
    const stage = await stageAppRuntimePackage({
      config: testConfig(coreDataDir),
      plan,
      isTrustedOrigin: () => true,
    });
    const unpack = await unpackAppRuntimePackage({
      config: testConfig(coreDataDir),
      plan,
      stage,
    });

    expect(unpack).toMatchObject({
      status: "unpacked",
      app_id: "talpaversum/inventory",
      package_sha256: stage.package_sha256,
      files: ["docker-compose.app.yml", "manifest/app-manifest.json"],
    });
    await expect(readFile(unpack.compose_file_path, "utf8")).resolves.toContain("services:");
  });

  it("rejects unsafe tar paths while unpacking", async () => {
    const content = tarGz([{ name: "../docker-compose.app.yml", content: "services: {}\n" }]);
    const coreDataDir = await mkdtemp(path.join(os.tmpdir(), "hc-runtime-package-"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(content));

    const plan = composePlan();
    const stage = await stageAppRuntimePackage({
      config: testConfig(coreDataDir),
      plan,
      isTrustedOrigin: () => true,
    });

    await expect(
      unpackAppRuntimePackage({
        config: testConfig(coreDataDir),
        plan,
        stage,
      }),
    ).rejects.toThrow("Runtime package contains an unsafe path");
  });

  it("rejects packages missing the requested compose file", async () => {
    const content = tarGz([{ name: "other.yml", content: "services: {}\n" }]);
    const coreDataDir = await mkdtemp(path.join(os.tmpdir(), "hc-runtime-package-"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(content));

    const plan = composePlan();
    const stage = await stageAppRuntimePackage({
      config: testConfig(coreDataDir),
      plan,
      isTrustedOrigin: () => true,
    });

    await expect(
      unpackAppRuntimePackage({
        config: testConfig(coreDataDir),
        plan,
        stage,
      }),
    ).rejects.toThrow("Runtime package does not contain compose_file");
  });
});
