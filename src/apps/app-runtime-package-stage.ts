import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EnvConfig } from "../config/index.js";

import type { AppRuntimeDeploymentPlan } from "./app-runtime-plan.js";
import { assertComposeRuntimePlan } from "./app-runtime-plan.js";
import { assertPublicOrigin } from "./manifest-fetcher.js";

const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

export type StageAppRuntimePackageResult = {
  status: "staged";
  app_id: string;
  package_url: string;
  package_sha256: string;
  package_path: string;
  size_bytes: number;
  staged_at: string;
};

type StageAppRuntimePackageOptions = {
  config: EnvConfig;
  plan: AppRuntimeDeploymentPlan;
  isTrustedOrigin?: (origin: string) => boolean | Promise<boolean>;
  timeoutMs?: number;
  maxBytes?: number;
};

function resolveCoreDataDir(config: EnvConfig): string {
  return path.resolve(process.cwd(), config.CORE_DATA_DIR);
}

function runtimePackageDir(config: EnvConfig, appId: string, packageSha256: string): string {
  const appKey = createHash("sha256").update(appId).digest("hex").slice(0, 16);
  return path.join(resolveCoreDataDir(config), "app-runtime-packages", appKey, packageSha256);
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const result = await reader.read();
    if (result.done) {
      break;
    }

    total += result.value.byteLength;
    if (total > maxBytes) {
      throw new Error(`Runtime package exceeds size limit (${maxBytes} bytes)`);
    }
    chunks.push(result.value);
  }

  return Buffer.concat(chunks);
}

async function assertFetchAllowed(
  packageUrl: URL,
  isTrustedOrigin?: (origin: string) => boolean | Promise<boolean>,
): Promise<void> {
  const trusted = (await isTrustedOrigin?.(packageUrl.origin)) ?? false;
  if (packageUrl.protocol !== "https:" && !trusted) {
    throw new Error("package_url must use https unless the origin is trusted");
  }

  if (!trusted) {
    await assertPublicOrigin(packageUrl);
  }
}

export async function stageAppRuntimePackage({
  config,
  plan,
  isTrustedOrigin,
  timeoutMs,
  maxBytes,
}: StageAppRuntimePackageOptions): Promise<StageAppRuntimePackageResult> {
  assertComposeRuntimePlan(plan);

  if (!plan.package_url) {
    throw new Error("compose deployment requires package_url");
  }

  const packageUrl = new URL(plan.package_url);
  await assertFetchAllowed(packageUrl, isTrustedOrigin);

  const response = await fetch(packageUrl, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs ?? FETCH_TIMEOUT_MS),
    headers: {
      accept: "application/gzip, application/x-gzip, application/octet-stream",
    },
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error("Runtime package redirect is not supported, use the target URL directly");
  }
  if (response.status !== 200) {
    throw new Error(`Runtime package fetch failed (${response.status})`);
  }

  const content = await readBodyWithLimit(response, maxBytes ?? MAX_PACKAGE_BYTES);
  if (content.length === 0) {
    throw new Error("Runtime package download failed: empty response body");
  }

  const packageSha256 = createHash("sha256").update(content).digest("hex");
  if (plan.package_sha256 && plan.package_sha256 !== packageSha256) {
    throw new Error("Runtime package hash does not match package_sha256");
  }

  const packageDir = runtimePackageDir(config, plan.app_id, packageSha256);
  await mkdir(packageDir, { recursive: true });
  const packagePath = path.join(packageDir, "package.tar.gz");
  await writeFile(packagePath, content);

  return {
    status: "staged",
    app_id: plan.app_id,
    package_url: packageUrl.toString(),
    package_sha256: packageSha256,
    package_path: packagePath,
    size_bytes: content.length,
    staged_at: new Date().toISOString(),
  };
}
