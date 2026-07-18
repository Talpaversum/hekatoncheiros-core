import { importPKCS8, SignJWT } from "jose";

import type { EnvConfig } from "../config/index.js";
import { HttpError } from "../shared/errors.js";

type CachedToken = { token: string; expiresAt: number };
const installationTokens = new Map<string, CachedToken>();

export async function getGitHubInstallationToken(installationId: string, config: EnvConfig) {
  const cached = installationTokens.get(installationId);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  if (!config.DEVELOPER_GITHUB_APP_ID || !config.DEVELOPER_GITHUB_APP_PRIVATE_KEY) {
    throw new HttpError(503, "GitHub App is not configured on this Core instance");
  }
  if (!/^\d+$/.test(installationId)) throw new HttpError(400, "Invalid GitHub App installation ID");
  const privateKey = await importPKCS8(
    config.DEVELOPER_GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    "RS256",
  );
  const now = Math.floor(Date.now() / 1000);
  const appJwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(config.DEVELOPER_GITHUB_APP_ID)
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 540)
    .sign(privateKey);
  const response = await fetch(
    new URL(
      `/app/installations/${installationId}/access_tokens`,
      config.DEVELOPER_GITHUB_API_URL ?? "https://api.github.com",
    ),
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt}`,
        "user-agent": "hekatoncheiros-core",
        "x-github-api-version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok)
    throw new HttpError(502, `GitHub App token exchange failed (${response.status})`);
  const payload = (await response.json()) as { token?: string; expires_at?: string };
  if (!payload.token || !payload.expires_at)
    throw new HttpError(502, "GitHub returned an invalid installation token");
  installationTokens.set(installationId, {
    token: payload.token,
    expiresAt: new Date(payload.expires_at).getTime(),
  });
  return payload.token;
}

export function forgetGitHubInstallationToken(installationId: string) {
  installationTokens.delete(installationId);
}
