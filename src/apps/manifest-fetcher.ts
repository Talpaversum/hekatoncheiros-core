import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

import { MANIFEST_SCHEMA_ID, validateManifest, type AppManifest } from "./manifest-validator.js";

const FETCH_TIMEOUT_MS = 8_000;
const MAX_MANIFEST_BYTES = 256_000;

const METADATA_HOSTS = new Set(["metadata.google.internal"]);
const MANIFEST_PATHS = ["/.well-known/hc-app-manifest.json", "/manifest.json"] as const;

type FetchManifestOptions = {
  timeoutMs?: number;
  maxBytes?: number;
};

export type FetchManifestResult = {
  normalizedBaseUrl: string;
  fetchedFromUrl: string;
  fetchedAt: string;
  manifest: AppManifest;
  manifestHash: string;
  manifestVersion: string;
  appVersion: string;
};

function normalizeBaseUrl(baseUrl: string): URL {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error("base_url is required");
  }

  const parsed = new URL(trimmed);
  if (parsed.protocol !== "https:") {
    throw new Error("base_url must use https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("base_url must not include username/password");
  }

  return new URL(parsed.origin);
}

function canonicalizeHost(hostname: string): string {
  return hostname.replace(/\.+$/, "").toLowerCase();
}

function isIpv4Private(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return false;
  }

  if (parts[0] === 10) {
    return true;
  }
  if (parts[0] === 127) {
    return true;
  }
  if (parts[0] === 169 && parts[1] === 254) {
    return true;
  }
  if (parts[0] === 192 && parts[1] === 168) {
    return true;
  }
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) {
    return true;
  }
  if (ip === "169.254.169.254") {
    return true;
  }

  return false;
}

function isIpv6Private(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") {
    return true;
  }
  if (normalized.startsWith("fe80:")) {
    return true;
  }

  const firstHextet = normalized.split(":")[0] ?? "";
  if (firstHextet.length > 0) {
    const value = Number.parseInt(firstHextet, 16);
    if (!Number.isNaN(value) && value >= 0xfc00 && value <= 0xfdff) {
      return true;
    }
  }

  return false;
}

function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    return isIpv4Private(ip);
  }
  if (family === 6) {
    return isIpv6Private(ip);
  }
  return true;
}

async function assertPublicOrigin(originUrl: URL): Promise<void> {
  const hostname = canonicalizeHost(originUrl.hostname);

  if (hostname === "localhost" || hostname.endsWith(".local") || METADATA_HOSTS.has(hostname)) {
    throw new Error("base_url points to a blocked host");
  }

  if (isIP(hostname) !== 0) {
    if (isBlockedIp(hostname)) {
      throw new Error("base_url points to a private or link-local IP");
    }
    return;
  }

  const resolved = await lookup(hostname, { all: true });
  if (resolved.length === 0) {
    throw new Error("base_url hostname resolution returned no records");
  }

  const blocked = resolved.find((entry) => isBlockedIp(entry.address));
  if (blocked) {
    throw new Error("base_url resolves to a blocked private/link-local address");
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const mapped = entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`);
  return `{${mapped.join(",")}}`;
}

function buildManifestHash(manifest: AppManifest): string {
  const canonicalJson = stableStringify(manifest);
  return createHash("sha256").update(canonicalJson).digest("hex");
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return "";
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
      throw new Error(`Manifest exceeds size limit (${maxBytes} bytes)`);
    }
    chunks.push(result.value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(merged);
}

async function fetchManifestAtUrl(url: URL, options: Required<FetchManifestOptions>): Promise<AppManifest | null> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs),
      headers: {
        accept: "application/json",
      },
    });
  } catch {
    return null;
  }

  if (response.status >= 300 && response.status < 400) {
    throw new Error("Redirect není podporován, použij cílovou URL přímo");
  }

  if (response.status === 404) {
    return null;
  }

  if (response.status !== 200) {
    throw new Error(`Manifest fetch failed (${response.status})`);
  }

  const raw = await readBodyWithLimit(response, options.maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Manifest response is not valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Manifest response must be a JSON object");
  }

  return parsed as AppManifest;
}

export async function fetchManifest(baseUrl: string, options?: FetchManifestOptions): Promise<FetchManifestResult> {
  const normalized = normalizeBaseUrl(baseUrl);
  await assertPublicOrigin(normalized);

  const normalizedBaseUrl = normalized.origin;
  const resolvedOptions: Required<FetchManifestOptions> = {
    timeoutMs: options?.timeoutMs ?? FETCH_TIMEOUT_MS,
    maxBytes: options?.maxBytes ?? MAX_MANIFEST_BYTES,
  };

  let manifest: AppManifest | null = null;
  let fetchedFrom: URL | null = null;

  for (const manifestPath of MANIFEST_PATHS) {
    const manifestUrl = new URL(manifestPath, normalizedBaseUrl);
    const fetched = await fetchManifestAtUrl(manifestUrl, resolvedOptions);
    if (fetched) {
      manifest = fetched;
      fetchedFrom = manifestUrl;
      break;
    }
  }

  if (!manifest || !fetchedFrom) {
    throw new Error("Manifest not found (.well-known/hc-app-manifest.json or /manifest.json)");
  }

  await validateManifest(manifest);

  const appVersion = manifest["version"];
  if (typeof appVersion !== "string" || appVersion.trim().length === 0) {
    throw new Error("Manifest is missing valid version");
  }

  return {
    normalizedBaseUrl,
    fetchedFromUrl: fetchedFrom.toString(),
    fetchedAt: new Date().toISOString(),
    manifest,
    manifestHash: buildManifestHash(manifest),
    manifestVersion: MANIFEST_SCHEMA_ID,
    appVersion,
  };
}
