import type { EnvConfig } from "../config/index.js";

export type PublicJwks = { keys: Array<Record<string, unknown>> };

function registryBaseUrl(config: EnvConfig): URL {
  if (!config.AUTHOR_REGISTRY_URL || !config.AUTHOR_REGISTRY_ADMIN_TOKEN) {
    throw new Error("Author registry integration is not configured");
  }
  const url = new URL(config.AUTHOR_REGISTRY_URL);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
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
  method?: "GET" | "POST";
  body?: unknown;
  authorId?: string;
  authenticated?: boolean;
}): Promise<T> {
  const baseUrl = registryBaseUrl(params.config);
  const response = await fetch(new URL(params.path, baseUrl), {
    method: params.method ?? "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
    headers: {
      accept: "application/json",
      ...(params.body ? { "content-type": "application/json" } : {}),
      ...(params.authenticated === false
        ? {}
        : { authorization: `Bearer ${params.config.AUTHOR_REGISTRY_ADMIN_TOKEN}` }),
      ...(params.authorId ? { "x-author-id": params.authorId } : {}),
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
}) {
  assertPublicJwks(params.jwks);
  const author = await registryRequest<{ author_id: string; display_name: string }>({
    config: params.config,
    path: "/v1/authors",
    method: "POST",
    body: { display_name: params.displayName },
  });
  await registryRequest({
    config: params.config,
    path: "/v1/authors/me/keys",
    method: "POST",
    authorId: author.author_id,
    body: { jwks: params.jwks },
  });
  const cert = await registryRequest<{ author_cert_jws: string; root_kid: string }>({
    config: params.config,
    path: "/v1/authors/me/certs/issue",
    method: "POST",
    authorId: author.author_id,
    body: { ttl_days: params.ttlDays },
  });
  return { ...author, ...cert };
}

export async function rotateAuthorKeys(params: {
  config: EnvConfig;
  authorId: string;
  jwks: PublicJwks;
  ttlDays: number;
}) {
  assertPublicJwks(params.jwks);
  await registryRequest({
    config: params.config,
    path: "/v1/authors/me/keys",
    method: "POST",
    authorId: params.authorId,
    body: { jwks: params.jwks },
  });
  return registryRequest<{ author_cert_jws: string; root_kid: string }>({
    config: params.config,
    path: "/v1/authors/me/certs/issue",
    method: "POST",
    authorId: params.authorId,
    body: { ttl_days: params.ttlDays },
  });
}

export async function fetchAuthorRegistryTrust(config: EnvConfig) {
  const [rootJwks, revocations] = await Promise.all([
    registryRequest<Record<string, unknown>>({
      config,
      path: "/v1/root/jwks",
      authenticated: false,
    }),
    registryRequest<Record<string, unknown>>({
      config,
      path: "/v1/revocations",
      authenticated: false,
    }),
  ]);
  return { rootJwks, revocations };
}

