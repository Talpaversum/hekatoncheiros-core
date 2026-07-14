import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWK } from "jose";

import type { EnvConfig } from "../config/index.js";

export type VerifiedAuthorUpdateSignal = {
  author_id: string;
  app_id: string;
  app_version: string;
  manifest_sha256: string;
  manifest_url: string;
  issued_at: string;
  expires_at: string;
};

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Signed update signal is missing ${key}`);
  }
  return value;
}

export async function verifyAuthorUpdateSignal(params: {
  updateSignalJws: string;
  authorCertJws: string;
  config: EnvConfig;
}): Promise<VerifiedAuthorUpdateSignal> {
  let rootJwks: JSONWebKeySet;
  try {
    rootJwks = JSON.parse(params.config.LICENSING_ROOT_JWKS_JSON) as JSONWebKeySet;
  } catch {
    throw new Error("Invalid LICENSING_ROOT_JWKS_JSON configuration");
  }

  const cert = await jwtVerify(params.authorCertJws, createLocalJWKSet(rootJwks), {
    issuer: "hc-author-registry",
    clockTolerance: params.config.LICENSING_CLOCK_SKEW_SECONDS,
  });
  if (cert.payload["typ"] !== "hc-author-cert") {
    throw new Error("Invalid author cert typ");
  }
  const authorId = requireString(cert.payload, "sub");
  const embeddedJwks = cert.payload["jwks"] as { keys?: JWK[] } | undefined;
  if (!embeddedJwks?.keys?.length) {
    throw new Error("Author cert does not contain embedded jwks.keys");
  }

  const verified = await jwtVerify(
    params.updateSignalJws,
    createLocalJWKSet({ keys: embeddedJwks.keys } as JSONWebKeySet),
    { clockTolerance: params.config.LICENSING_CLOCK_SKEW_SECONDS },
  );
  const payload = verified.payload;
  if (payload["typ"] !== "hc-app-update") {
    throw new Error("Invalid signed update signal typ");
  }
  if (payload.iss !== authorId) {
    throw new Error("Signed update signal issuer does not match author cert");
  }

  const appId = requireString(payload, "sub");
  if (!appId.startsWith(`${authorId}/`)) {
    throw new Error("Signed update signal app_id is outside the author namespace");
  }
  const appVersion = requireString(payload, "app_version");
  const manifestSha256 = requireString(payload, "manifest_sha256").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(manifestSha256)) {
    throw new Error("Signed update signal manifest_sha256 is invalid");
  }
  const manifestUrl = requireString(payload, "manifest_url");
  new URL(manifestUrl);
  if (typeof payload.iat !== "number" || typeof payload.exp !== "number") {
    throw new Error("Signed update signal requires iat and exp");
  }
  if (payload.exp <= payload.iat || payload.exp - payload.iat > 7 * 24 * 60 * 60) {
    throw new Error("Signed update signal validity must not exceed seven days");
  }

  return {
    author_id: authorId,
    app_id: appId,
    app_version: appVersion,
    manifest_sha256: manifestSha256,
    manifest_url: new URL(manifestUrl).toString(),
    issued_at: new Date(payload.iat * 1000).toISOString(),
    expires_at: new Date(payload.exp * 1000).toISOString(),
  };
}
