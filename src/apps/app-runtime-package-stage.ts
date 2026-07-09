import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";

import type { EnvConfig } from "../config/index.js";

import type { AppRuntimeDeploymentPlan } from "./app-runtime-plan.js";
import { assertComposeRuntimePlan } from "./app-runtime-plan.js";
import { assertPublicOrigin } from "./manifest-fetcher.js";

const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;
const MAX_TAR_ENTRIES = 2_000;
const FETCH_TIMEOUT_MS = 30_000;
const gunzipAsync = promisify(gunzip);

export type StageAppRuntimePackageResult = {
  status: "staged";
  app_id: string;
  package_url: string;
  package_sha256: string;
  package_path: string;
  size_bytes: number;
  staged_at: string;
};

export type UnpackAppRuntimePackageResult = {
  status: "unpacked";
  app_id: string;
  package_sha256: string;
  unpacked_dir: string;
  compose_file_path: string;
  files: string[];
  total_size_bytes: number;
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

function parseOctal(raw: Buffer): number {
  const value = raw.toString("utf8").replace(/\0.*$/, "").trim();
  if (!value) {
    return 0;
  }

  const parsed = Number.parseInt(value, 8);
  if (Number.isNaN(parsed) || parsed < 0) {
    throw new Error("Runtime package tar entry has invalid size");
  }

  return parsed;
}

function readTarString(raw: Buffer): string {
  return raw.toString("utf8").replace(/\0.*$/, "").trim();
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function normalizeTarPath(rawPath: string): string {
  const normalized = path.posix.normalize(rawPath.replaceAll("\\", "/"));
  const parts = normalized.split("/");

  if (
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized) ||
    parts.some((part) => part === ".." || part.length === 0)
  ) {
    throw new Error("Runtime package contains an unsafe path");
  }

  return normalized;
}

function safeJoin(root: string, relativePath: string): string {
  const targetPath = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Runtime package extraction escaped target directory");
  }

  return targetPath;
}

type TarEntry = {
  relativePath: string;
  typeFlag: string;
  content: Buffer;
};

function parseTar(buffer: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (isZeroBlock(header)) {
      break;
    }

    if (entries.length >= MAX_TAR_ENTRIES) {
      throw new Error(`Runtime package exceeds entry limit (${MAX_TAR_ENTRIES})`);
    }

    const name = readTarString(header.subarray(0, 100));
    const prefix = readTarString(header.subarray(345, 500));
    const rawPath = prefix ? `${prefix}/${name}` : name;
    const relativePath = normalizeTarPath(rawPath);
    const typeFlag = readTarString(header.subarray(156, 157)) || "0";
    const size = parseOctal(header.subarray(124, 136));
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > buffer.length) {
      throw new Error("Runtime package tar entry is truncated");
    }

    if (typeFlag !== "0" && typeFlag !== "5") {
      throw new Error("Runtime package may only contain regular files and directories");
    }

    entries.push({
      relativePath,
      typeFlag,
      content: typeFlag === "0" ? buffer.subarray(contentStart, contentEnd) : Buffer.alloc(0),
    });

    offset = contentStart + Math.ceil(size / 512) * 512;
  }

  return entries;
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

export async function unpackAppRuntimePackage({
  config,
  plan,
  stage,
}: {
  config: EnvConfig;
  plan: AppRuntimeDeploymentPlan;
  stage: StageAppRuntimePackageResult;
}): Promise<UnpackAppRuntimePackageResult> {
  assertComposeRuntimePlan(plan);

  if (!plan.compose_file) {
    throw new Error("compose deployment requires compose_file");
  }

  const packageContent = await readFile(stage.package_path);
  const unpackedContent = await gunzipAsync(packageContent);
  if (unpackedContent.length > MAX_UNPACKED_BYTES) {
    throw new Error(`Runtime package unpacked size exceeds limit (${MAX_UNPACKED_BYTES} bytes)`);
  }

  const entries = parseTar(unpackedContent);
  const unpackedDir = path.join(
    runtimePackageDir(config, plan.app_id, stage.package_sha256),
    "unpacked",
  );
  let totalSizeBytes = 0;
  const files: string[] = [];

  for (const entry of entries) {
    const targetPath = safeJoin(unpackedDir, entry.relativePath);
    if (entry.typeFlag === "5") {
      await mkdir(targetPath, { recursive: true });
      continue;
    }

    totalSizeBytes += entry.content.length;
    if (totalSizeBytes > MAX_UNPACKED_BYTES) {
      throw new Error(`Runtime package unpacked size exceeds limit (${MAX_UNPACKED_BYTES} bytes)`);
    }

    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, entry.content);
    files.push(entry.relativePath);
  }

  if (!files.includes(plan.compose_file)) {
    throw new Error("Runtime package does not contain compose_file");
  }

  return {
    status: "unpacked",
    app_id: plan.app_id,
    package_sha256: stage.package_sha256,
    unpacked_dir: unpackedDir,
    compose_file_path: safeJoin(unpackedDir, plan.compose_file),
    files,
    total_size_bytes: totalSizeBytes,
  };
}
