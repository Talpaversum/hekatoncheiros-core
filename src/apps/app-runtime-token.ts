import { createHash } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import path from "node:path";

import { SignJWT } from "jose";

import type { EnvConfig } from "../config/index.js";

export const APP_RUNTIME_TOKEN_TTL_SECONDS = 60 * 15;
export const APP_RUNTIME_TOKEN_SECRET_NAME = "hc_core_app_token";
export const APP_RUNTIME_TOKEN_CONTAINER_PATH = `/run/secrets/${APP_RUNTIME_TOKEN_SECRET_NAME}`;

function tokenDirectory(config: EnvConfig, appId: string): string {
  const appKey = createHash("sha256").update(appId).digest("hex").slice(0, 16);
  return path.resolve(process.cwd(), config.CORE_DATA_DIR, "app-runtime-tokens", appKey);
}

export function getAppRuntimeTokenFilePath(config: EnvConfig, appId: string): string {
  return path.join(tokenDirectory(config, appId), "core-api.jwt");
}

export async function issueAppRuntimeToken(params: {
  appId: string;
  tenantId: string;
  config: EnvConfig;
}) {
  const expiresAt = new Date(Date.now() + APP_RUNTIME_TOKEN_TTL_SECONDS * 1000);
  const jwt = await new SignJWT({
    app_id: params.appId,
    tenant_id: params.tenantId,
    purpose: "core-api",
    privileges: ["core.audit.append"],
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(params.appId)
    .setIssuer(params.config.JWT_ISSUER)
    .setAudience(params.config.JWT_AUDIENCE_APP)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(new TextEncoder().encode(params.config.JWT_SECRET));

  return { jwt, expiresAt };
}

export async function deliverAppRuntimeToken(params: {
  appId: string;
  token: string;
  config: EnvConfig;
}) {
  const directory = tokenDirectory(params.config, params.appId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const tokenFilePath = getAppRuntimeTokenFilePath(params.config, params.appId);
  const handle = await open(tokenFilePath, "w", 0o600);
  try {
    await handle.writeFile(`${params.token}\n`, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }

  return { token_file_path: tokenFilePath };
}
