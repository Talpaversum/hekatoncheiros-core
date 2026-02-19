import { randomUUID } from "node:crypto";

import { SignJWT } from "jose";

import type { EnvConfig } from "../config/index.js";

const INSTALLER_TOKEN_TTL_SECONDS = 60 * 5;

export async function issueInstallerToken(params: {
  appId: string;
  slug: string;
  config: EnvConfig;
}): Promise<string> {
  const { appId, slug, config } = params;
  const secret = new TextEncoder().encode(config.INSTALLER_TOKEN_SECRET);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    app_id: appId,
    slug,
    purpose: "ui-artifact-fetch",
    nonce: randomUUID(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(config.INSTALLER_TOKEN_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + INSTALLER_TOKEN_TTL_SECONDS)
    .sign(secret);
}

export async function issueInstallationCompleteToken(params: {
  appId: string;
  tenantId: string;
  config: EnvConfig;
}): Promise<string> {
  const { appId, tenantId, config } = params;
  const secret = new TextEncoder().encode(config.INSTALLER_TOKEN_SECRET);
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    app_id: appId,
    tenant_id: tenantId,
    purpose: "installation-complete",
    nonce: randomUUID(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(config.INSTALLER_TOKEN_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + INSTALLER_TOKEN_TTL_SECONDS)
    .sign(secret);
}
