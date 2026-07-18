import type { EnvConfig } from "../config/index.js";

export type PublicJwks = { keys: Array<Record<string, unknown>> };

function registryBaseUrl(config: EnvConfig): URL {
  if (!config.AUTHOR_REGISTRY_URL) {
    throw new Error("Author registry integration is not configured");
  }
  const url = new URL(config.AUTHOR_REGISTRY_URL);
  if (url.protocol !== "https:" && !config.AUTHOR_REGISTRY_ALLOW_HTTP && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("AUTHOR_REGISTRY_URL must use HTTPS outside localhost");
  }
  return new URL(url.origin);
}

function assertPublicJwks(jwks: PublicJwks): void {
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) {
    throw new Error("At least one author public key is required");
  }
  const kids = new Set<string>();
  for (const key of jwks.keys) {
    if (typeof key["kid"] !== "string" || !key["kid"]) {
      throw new Error("Every author public key requires kid");
    }
    if ("d" in key || "p" in key || "q" in key || "dp" in key || "dq" in key || "qi" in key) {
      throw new Error("Author JWKS must contain public keys only");
    }
    if (kids.has(key["kid"])) {
      throw new Error("Author JWKS contains duplicate kid");
    }
    kids.add(key["kid"]);
  }
}

async function registryRequest<T>(params: {
  config: EnvConfig;
  path: string;
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  authenticated?: boolean;
  delegatedUserToken?: string;
}): Promise<T> {
  const baseUrl = registryBaseUrl(params.config);
  const response = await fetch(new URL(params.path, baseUrl), {
    method: params.method ?? "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: "application/json",
      ...(params.body ? { "content-type": "application/json" } : {}),
      ...(params.authenticated === false || !params.delegatedUserToken ? {} : { "x-hc-user-delegation": params.delegatedUserToken }),
    },
    body: params.body ? JSON.stringify(params.body) : undefined,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Author registry request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function onboardAuthor(params: {
  config: EnvConfig;
  displayName: string;
  jwks: PublicJwks;
  ttlDays: number;
  operatingMode: "talpaversum_hosted" | "trusted_self_hosted";
  delegatedUserToken?: string;
}) {
  assertPublicJwks(params.jwks);
  const author = await registryRequest<{ author_id: string; display_name: string }>({
    config: params.config,
    path: "/v1/admin/authors",
    method: "POST",
    body: { display_name: params.displayName, operating_mode: params.operatingMode },
    delegatedUserToken: params.delegatedUserToken,
  });
  await registryRequest({
    config: params.config,
    path: `/v1/admin/authors/${encodeURIComponent(author.author_id)}/keys`,
    method: "POST",
    body: { jwks: params.jwks },
    delegatedUserToken: params.delegatedUserToken,
  });
  await registryRequest({
    config: params.config,
    path: `/v1/admin/authors/${encodeURIComponent(author.author_id)}/status`,
    method: "POST",
    body: { status: "active", notes: "Approved during Core author onboarding" },
    delegatedUserToken: params.delegatedUserToken,
  });
  const cert = await registryRequest<{ author_cert_jws: string; root_kid: string }>({
    config: params.config,
    path: `/v1/admin/authors/${encodeURIComponent(author.author_id)}/certificates`,
    method: "POST",
    body: { ttl_days: params.ttlDays },
    delegatedUserToken: params.delegatedUserToken,
  });
  return { ...author, ...cert };
}

export async function rotateAuthorKeys(params: {
  config: EnvConfig;
  authorId: string;
  jwks: PublicJwks;
  ttlDays: number;
  delegatedUserToken?: string;
}) {
  assertPublicJwks(params.jwks);
  await registryRequest({
    config: params.config,
    path: `/v1/admin/authors/${encodeURIComponent(params.authorId)}/keys`,
    method: "POST",
    body: { jwks: params.jwks },
    delegatedUserToken: params.delegatedUserToken,
  });
  return registryRequest<{ author_cert_jws: string; root_kid: string }>({
    config: params.config,
    path: `/v1/admin/authors/${encodeURIComponent(params.authorId)}/certificates`,
    method: "POST",
    body: { ttl_days: params.ttlDays },
    delegatedUserToken: params.delegatedUserToken,
  });
}

export async function fetchAuthorRegistryTrust(config: EnvConfig) {
  const [trustAnchor, revocations] = await Promise.all([
    registryRequest<Record<string, unknown>>({
      config,
      path: "/v1/trust-anchor",
      authenticated: false,
    }),
    registryRequest<Record<string, unknown>>({
      config,
      path: "/v1/revocations",
      authenticated: false,
    }),
  ]);
  const rootJwks = (trustAnchor["root_jwks"] ?? {}) as Record<string, unknown>;
  return { trustAnchor, rootJwks, revocations };
}

export async function fetchRegistryDashboard(config: EnvConfig, delegatedUserToken: string) {
  return registryRequest<Record<string, unknown>>({ config, path: "/v1/admin/dashboard", delegatedUserToken });
}

export async function fetchRegistryAuthors(config: EnvConfig, delegatedUserToken: string) {
  return registryRequest<{ items: Array<Record<string, unknown>> }>({ config, path: "/v1/admin/authors", delegatedUserToken });
}

export async function updateRegistryAuthor(config: EnvConfig, delegatedUserToken: string, authorId: string, action: "approve" | "suspend" | "revoke", reason?: string) {
  if (action === "revoke") return registryRequest<Record<string, unknown>>({
    config, path: `/v1/admin/authors/${encodeURIComponent(authorId)}/revoke`, method: "POST",
    body: { reason: reason ?? "Revoked by registry operator" }, delegatedUserToken,
  });
  return registryRequest<Record<string, unknown>>({
    config, path: `/v1/admin/authors/${encodeURIComponent(authorId)}/status`, method: "POST",
    body: { status: action === "approve" ? "active" : "suspended", notes: reason }, delegatedUserToken,
  });
}

export async function fetchRegistryAudit(config: EnvConfig, delegatedUserToken: string) {
  return registryRequest<{ items: Array<Record<string, unknown>> }>({ config, path: "/v1/admin/audit", delegatedUserToken });
}

export async function fetchRegistryAuthorDetail(config: EnvConfig, delegatedUserToken: string, authorId: string) {
  return registryRequest<Record<string, unknown>>({ config, path: `/v1/admin/authors/${encodeURIComponent(authorId)}`, delegatedUserToken });
}

export async function mutateRegistryLifecycle(config: EnvConfig, delegatedUserToken: string, path: string, method: "POST" | "DELETE", body?: unknown) {
  return registryRequest<Record<string, unknown>>({ config, path, method, body, delegatedUserToken });
}
