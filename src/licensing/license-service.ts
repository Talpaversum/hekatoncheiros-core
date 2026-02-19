import { createHash, randomUUID } from "node:crypto";

import {
  SignJWT,
  createLocalJWKSet,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JSONWebKeySet,
  type JWK,
  type JWTPayload,
  type JWSHeaderParameters,
} from "jose";

import { loadConfig } from "../config/index.js";
import { getPool } from "../db/pool.js";
import { HttpError, NotFoundError } from "../shared/errors.js";
import { assertAuthorScopedAppId, isValidAuthorScopedAppId } from "./app-id.js";
import { getPlatformInstanceAudienceId } from "./platform-instance-service.js";

export type LicenseStatus = "active" | "invalid" | "expired" | "revoked" | "disabled";
export type LicenseMode = "portable" | "instance_bound";

export interface TenantLicenseRecord {
  id: string;
  tenant_id: string;
  author_id: string;
  app_id: string;
  jti: string;
  license_mode: LicenseMode;
  audience: string[];
  license_jws: string;
  author_cert_jws: string | null;
  author_kid: string | null;
  status: LicenseStatus;
  valid_from: string | null;
  valid_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface ParsedLicenseClaims {
  author_id: string;
  app_id: string;
  jti: string;
  license_mode: LicenseMode;
  audience: string[];
  tenant_id: string;
  valid_from: string | null;
  valid_to: string | null;
  author_kid: string | null;
}

export interface LicenseValidationResult {
  valid: boolean;
  chain_verified: boolean;
  status: LicenseStatus;
  claims: ParsedLicenseClaims | null;
  errors: string[];
}

export interface ImportLicenseInput {
  tenantId: string;
  license_jws: string;
  author_cert_jws?: string | null;
}

interface OAuthState {
  tenantId: string;
  issuerUrl: string;
  appId: string;
  licenseMode: LicenseMode;
  codeVerifier: string;
  tokenEndpoint: string;
  issueEndpoint: string;
  autoSelect: boolean;
  createdAt: number;
}

const OAUTH_STATE_TTL_MS = 10 * 60_000;
const oauthStateStore = new Map<string, OAuthState>();

function toIso(value: unknown): string {
  return new Date(String(value)).toISOString();
}

function toTimestamptzOrNull(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  if (Number.isNaN(time)) {
    return null;
  }
  return new Date(time).toISOString();
}

function mapLicenseRow(row: Record<string, unknown>): TenantLicenseRecord {
  return {
    id: String(row["id"]),
    tenant_id: String(row["tenant_id"]),
    author_id: String(row["author_id"]),
    app_id: String(row["app_id"]),
    jti: String(row["jti"]),
    license_mode: String(row["license_mode"]) as LicenseMode,
    audience: (row["audience"] ?? []) as string[],
    license_jws: String(row["license_jws"]),
    author_cert_jws: row["author_cert_jws"] ? String(row["author_cert_jws"]) : null,
    author_kid: row["author_kid"] ? String(row["author_kid"]) : null,
    status: String(row["status"]) as LicenseStatus,
    valid_from: row["valid_from"] ? toIso(row["valid_from"]) : null,
    valid_to: row["valid_to"] ? toIso(row["valid_to"]) : null,
    created_at: toIso(row["created_at"]),
    updated_at: toIso(row["updated_at"]),
  };
}

function toArray(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function parseRootJwks() {
  const config = loadConfig();
  try {
    const parsed = JSON.parse(config.LICENSING_ROOT_JWKS_JSON) as JSONWebKeySet;
    return createLocalJWKSet(parsed);
  } catch {
    throw new HttpError(500, "Invalid LICENSING_ROOT_JWKS_JSON configuration");
  }
}

function requireStringClaim(payload: JWTPayload, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `Missing claim: ${key}`);
  }
  return value;
}

function getLicenseStatus(params: {
  payload: JWTPayload;
  revoked: boolean;
  invalid: boolean;
}): LicenseStatus {
  if (params.revoked) {
    return "revoked";
  }
  if (params.invalid) {
    return "invalid";
  }
  const exp = typeof params.payload.exp === "number" ? params.payload.exp : null;
  if (exp && exp * 1000 <= Date.now()) {
    return "expired";
  }
  return "active";
}

async function isLocallyRevoked(authorId: string, authorKid: string | null, jti: string): Promise<boolean> {
  const pool = getPool();
  const values: Array<[string, string]> = [
    ["author_id", authorId],
    ["license_jti", jti],
  ];
  if (authorKid) {
    values.push(["author_kid", authorKid]);
  }

  const checks = await Promise.all(
    values.map(([type, value]) =>
      pool.query("select 1 from core.license_revocations_local where type = $1 and value = $2 limit 1", [type, value]),
    ),
  );
  return checks.some((result) => (result.rowCount ?? 0) > 0);
}

function assertLicenseAudience(mode: LicenseMode, audience: string[], platformInstanceId: string) {
  if (mode === "portable") {
    if (!audience.includes("*")) {
      throw new HttpError(400, "portable license must include aud=['*']");
    }
    return;
  }

  if (!audience.includes(platformInstanceId)) {
    throw new HttpError(400, "instance_bound license audience does not contain local platform instance id");
  }
}

async function verifyLicenseMaterial(input: ImportLicenseInput): Promise<{
  claims: ParsedLicenseClaims;
  licensePayload: JWTPayload;
  status: LicenseStatus;
}> {
  const config = loadConfig();
  if (!input.author_cert_jws) {
    throw new HttpError(400, "author_cert_jws is required");
  }

  const rootJwks = parseRootJwks();
  const certVerified = await jwtVerify(input.author_cert_jws, rootJwks, {
    issuer: "hc-author-registry",
    clockTolerance: config.LICENSING_CLOCK_SKEW_SECONDS,
  });

  const certPayload = certVerified.payload;
  const certType = certPayload["typ"];
  if (certType !== "hc-author-cert") {
    throw new HttpError(400, "Invalid author cert typ");
  }

  const authorId = requireStringClaim(certPayload, "sub");
  const embeddedJwks = certPayload["jwks"] as { keys?: JWK[] } | undefined;
  if (!embeddedJwks || !Array.isArray(embeddedJwks.keys) || embeddedJwks.keys.length === 0) {
    throw new HttpError(400, "Author cert does not contain embedded jwks.keys");
  }

  const authorJwks = createLocalJWKSet({ keys: embeddedJwks.keys } as JSONWebKeySet);
  const licenseVerified = await jwtVerify(input.license_jws, authorJwks, {
    clockTolerance: config.LICENSING_CLOCK_SKEW_SECONDS,
  });

  const licensePayload = licenseVerified.payload;
  const header = decodeProtectedHeader(input.license_jws);
  const authorKid = typeof header.kid === "string" ? header.kid : null;
  const licenseTyp = licensePayload["typ"];
  if (licenseTyp !== "hc-license") {
    throw new HttpError(400, "Invalid license typ");
  }

  const iss = requireStringClaim(licensePayload, "iss");
  if (iss !== authorId) {
    throw new HttpError(400, "license.iss must match author cert sub");
  }

  const subject = (licensePayload["subject"] ?? {}) as Record<string, unknown>;
  const scopeType = subject["scope_type"];
  const tenantId = subject["tenant_id"];
  if (scopeType !== "tenant" || typeof tenantId !== "string") {
    throw new HttpError(400, "License subject must be tenant scoped");
  }
  if (tenantId !== input.tenantId) {
    throw new HttpError(400, "License tenant_id does not match route tenant");
  }

  const app = (licensePayload["app"] ?? {}) as Record<string, unknown>;
  const appId = typeof app["app_id"] === "string" ? app["app_id"] : "";
  assertAuthorScopedAppId(appId);
  if (!appId.startsWith(`${authorId}/`)) {
    throw new HttpError(400, "app.app_id prefix must match license issuer author_id");
  }

  const jti = requireStringClaim(licensePayload, "jti");
  const mode = licensePayload["license_mode"];
  if (mode !== "portable" && mode !== "instance_bound") {
    throw new HttpError(400, "license_mode must be portable or instance_bound");
  }

  const hcpi = await getPlatformInstanceAudienceId();
  const audience = toArray(licensePayload.aud);
  assertLicenseAudience(mode, audience, hcpi);

  const revoked = await isLocallyRevoked(authorId, authorKid, jti);
  const status = getLicenseStatus({ payload: licensePayload, revoked, invalid: false });

  return {
    claims: {
      author_id: authorId,
      app_id: appId,
      jti,
      license_mode: mode,
      audience,
      tenant_id: tenantId,
      valid_from: typeof licensePayload.nbf === "number" ? new Date(licensePayload.nbf * 1000).toISOString() : null,
      valid_to: typeof licensePayload.exp === "number" ? new Date(licensePayload.exp * 1000).toISOString() : null,
      author_kid: authorKid,
    },
    licensePayload,
    status,
  };
}

export async function validateLicenseMaterial(input: ImportLicenseInput): Promise<LicenseValidationResult> {
  try {
    const verified = await verifyLicenseMaterial(input);
    return {
      valid: verified.status === "active",
      chain_verified: true,
      status: verified.status,
      claims: verified.claims,
      errors: [],
    };
  } catch (error) {
    return {
      valid: false,
      chain_verified: false,
      status: "invalid",
      claims: null,
      errors: [error instanceof Error ? error.message : "validation_failed"],
    };
  }
}

export async function importLicenseMaterial(input: ImportLicenseInput): Promise<TenantLicenseRecord> {
  const verified = await verifyLicenseMaterial(input);
  const pool = getPool();

  const upsert = await pool.query(
    `insert into core.tenant_licenses
      (tenant_id, author_id, app_id, jti, license_mode, audience, license_jws, author_cert_jws, author_kid, status, valid_from, valid_to, updated_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11::timestamptz,$12::timestamptz, now())
     on conflict (jti)
     do update set
      tenant_id = excluded.tenant_id,
      author_id = excluded.author_id,
      app_id = excluded.app_id,
      license_mode = excluded.license_mode,
      audience = excluded.audience,
      license_jws = excluded.license_jws,
      author_cert_jws = excluded.author_cert_jws,
      author_kid = excluded.author_kid,
      status = excluded.status,
      valid_from = excluded.valid_from,
      valid_to = excluded.valid_to,
      updated_at = now()
     returning id, tenant_id, author_id, app_id, jti, license_mode, audience, license_jws, author_cert_jws, author_kid, status, valid_from, valid_to, created_at, updated_at`,
    [
      input.tenantId,
      verified.claims.author_id,
      verified.claims.app_id,
      verified.claims.jti,
      verified.claims.license_mode,
      JSON.stringify(verified.claims.audience),
      input.license_jws,
      input.author_cert_jws ?? null,
      verified.claims.author_kid,
      verified.status,
      toTimestamptzOrNull(verified.claims.valid_from),
      toTimestamptzOrNull(verified.claims.valid_to),
    ],
  );

  return mapLicenseRow(upsert.rows[0] as Record<string, unknown>);
}

export async function listTenantLicenses(tenantId: string, appId?: string): Promise<TenantLicenseRecord[]> {
  const pool = getPool();
  const result = appId
    ? await pool.query(
        `select id, tenant_id, author_id, app_id, jti, license_mode, audience, license_jws, author_cert_jws, author_kid, status, valid_from, valid_to, created_at, updated_at
         from core.tenant_licenses
         where tenant_id = $1 and app_id = $2
         order by created_at desc, id desc`,
        [tenantId, appId],
      )
    : await pool.query(
        `select id, tenant_id, author_id, app_id, jti, license_mode, audience, license_jws, author_cert_jws, author_kid, status, valid_from, valid_to, created_at, updated_at
         from core.tenant_licenses
         where tenant_id = $1
         order by created_at desc, id desc`,
        [tenantId],
      );

  return result.rows.map((row) => mapLicenseRow(row as Record<string, unknown>));
}

export async function getLicenseByJti(tenantId: string, jti: string): Promise<TenantLicenseRecord | null> {
  const pool = getPool();
  const result = await pool.query(
    `select id, tenant_id, author_id, app_id, jti, license_mode, audience, license_jws, author_cert_jws, author_kid, status, valid_from, valid_to, created_at, updated_at
     from core.tenant_licenses
     where tenant_id = $1 and jti = $2
     limit 1`,
    [tenantId, jti],
  );
  if ((result.rowCount ?? 0) === 0) {
    return null;
  }
  return mapLicenseRow(result.rows[0] as Record<string, unknown>);
}

export async function selectTenantLicense(tenantId: string, appId: string, licenseJti: string): Promise<void> {
  assertAuthorScopedAppId(appId);
  const pool = getPool();
  const candidate = await pool.query(
    "select status from core.tenant_licenses where tenant_id = $1 and app_id = $2 and jti = $3 limit 1",
    [tenantId, appId, licenseJti],
  );

  if ((candidate.rowCount ?? 0) === 0) {
    throw new NotFoundError("License not found for tenant/app");
  }

  const status = String(candidate.rows[0].status);
  if (status !== "active") {
    throw new HttpError(400, "Only active license can be selected");
  }

  await pool.query(
    `insert into core.tenant_app_license_selection (tenant_id, app_id, license_jti, selected_at)
     values ($1,$2,$3,now())
     on conflict (tenant_id, app_id)
     do update set license_jti = excluded.license_jti, selected_at = now()`,
    [tenantId, appId, licenseJti],
  );
}

export async function clearSelectedTenantLicense(tenantId: string, appId: string): Promise<void> {
  const pool = getPool();
  await pool.query("delete from core.tenant_app_license_selection where tenant_id = $1 and app_id = $2", [tenantId, appId]);
}

export async function getSelectedTenantLicense(tenantId: string, appId: string): Promise<TenantLicenseRecord | null> {
  const pool = getPool();
  const selected = await pool.query(
    `select l.id, l.tenant_id, l.author_id, l.app_id, l.jti, l.license_mode, l.audience, l.license_jws, l.author_cert_jws, l.author_kid, l.status, l.valid_from, l.valid_to, l.created_at, l.updated_at
     from core.tenant_app_license_selection s
     join core.tenant_licenses l on l.jti = s.license_jti
     where s.tenant_id = $1 and s.app_id = $2
     limit 1`,
    [tenantId, appId],
  );
  if ((selected.rowCount ?? 0) === 0) {
    return null;
  }
  return mapLicenseRow(selected.rows[0] as Record<string, unknown>);
}

export async function hasSelectedActiveLicense(tenantId: string, appId: string): Promise<boolean> {
  const selected = await getSelectedTenantLicense(tenantId, appId);
  return selected?.status === "active";
}

export async function hasAnyTenantLicense(tenantId: string, appId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    "select 1 from core.tenant_licenses where tenant_id = $1 and app_id = $2 limit 1",
    [tenantId, appId],
  );
  return (result.rowCount ?? 0) > 0;
}

function base64Url(input: Uint8Array): string {
  return Buffer.from(input).toString("base64url");
}

async function signSoftwareStatement(tenantId: string): Promise<string> {
  const config = loadConfig();
  if (!config.LICENSING_DCR_SIGNING_PRIVATE_JWK_JSON) {
    throw new HttpError(500, "Missing LICENSING_DCR_SIGNING_PRIVATE_JWK_JSON for DCR software_statement signing");
  }

  const privateJwk = JSON.parse(config.LICENSING_DCR_SIGNING_PRIVATE_JWK_JSON) as Record<string, unknown>;
  const key = await importJWK(privateJwk, "EdDSA");
  const now = Math.floor(Date.now() / 1000);
  const hcpi = await getPlatformInstanceAudienceId();

  return new SignJWT({
    platform_instance_id: hcpi,
    tenant_id: tenantId,
  })
    .setProtectedHeader({
      alg: "EdDSA",
      kid: typeof privateJwk["kid"] === "string" ? privateJwk["kid"] : undefined,
    })
    .setIssuer("hekatoncheiros-core")
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(key);
}

function cleanupOAuthState() {
  const now = Date.now();
  for (const [key, state] of oauthStateStore.entries()) {
    if (now - state.createdAt > OAUTH_STATE_TTL_MS) {
      oauthStateStore.delete(key);
    }
  }
}

function resolveEndpoint(issuer: string, maybePathOrAbsolute: unknown, fallbackPath: string): string {
  const base = new URL(issuer);
  if (typeof maybePathOrAbsolute === "string" && maybePathOrAbsolute.trim()) {
    return new URL(maybePathOrAbsolute, base).toString();
  }
  return new URL(fallbackPath, base).toString();
}

async function upsertOAuthConnection(params: {
  tenantId: string;
  issuerUrl: string;
  appId: string;
  clientId: string;
  clientSecret: string | null;
}): Promise<void> {
  const pool = getPool();
  await pool.query(
    `insert into core.oauth_connections (tenant_id, issuer_url, app_id, client_id, client_secret_enc, updated_at)
     values ($1,$2,$3,$4,$5,now())
     on conflict (issuer_url, client_id)
     do update set tenant_id = excluded.tenant_id, app_id = excluded.app_id, client_secret_enc = excluded.client_secret_enc, updated_at = now()`,
    [params.tenantId, params.issuerUrl, params.appId, params.clientId, params.clientSecret],
  );
}

async function getOAuthConnection(tenantId: string, issuerUrl: string, appId: string): Promise<{
  client_id: string;
  client_secret_enc: string | null;
} | null> {
  const pool = getPool();
  const result = await pool.query(
    `select client_id, client_secret_enc
     from core.oauth_connections
     where tenant_id = $1 and issuer_url = $2 and (app_id = $3 or app_id is null)
     order by app_id nulls last, created_at desc
     limit 1`,
    [tenantId, issuerUrl, appId],
  );
  if ((result.rowCount ?? 0) === 0) {
    return null;
  }
  return {
    client_id: String(result.rows[0].client_id),
    client_secret_enc: result.rows[0].client_secret_enc ? String(result.rows[0].client_secret_enc) : null,
  };
}

export async function startLicenseOAuth(params: {
  tenantId: string;
  issuerUrl: string;
  appId: string;
  licenseMode: LicenseMode;
  autoSelect?: boolean;
}): Promise<{ redirect_url: string; state: string }> {
  assertAuthorScopedAppId(params.appId);
  cleanupOAuthState();

  const discoveryUrl = new URL("/.well-known/hc-licensing", params.issuerUrl).toString();
  const discoveryResponse = await fetch(discoveryUrl);
  if (!discoveryResponse.ok) {
    throw new HttpError(400, "Unable to fetch issuer discovery metadata");
  }
  const discovery = (await discoveryResponse.json()) as Record<string, unknown>;

  const authorizeEndpoint = resolveEndpoint(params.issuerUrl, discovery["authorization_endpoint"], "/oauth/authorize");
  const tokenEndpoint = resolveEndpoint(params.issuerUrl, discovery["token_endpoint"], "/oauth/token");
  const issueEndpoint = resolveEndpoint(params.issuerUrl, discovery["license_issue_endpoint"], "/v1/licenses/issue");
  const registerEndpoint = resolveEndpoint(params.issuerUrl, discovery["registration_endpoint"], "/oauth/register");

  let connection = await getOAuthConnection(params.tenantId, params.issuerUrl, params.appId);
  if (!connection) {
    const softwareStatement = await signSoftwareStatement(params.tenantId);
    const callbackUrl = `${loadConfig().LICENSING_OAUTH_CALLBACK_BASE_URL}/api/v1/tenants/${encodeURIComponent(params.tenantId)}/licenses/oauth/callback`;

    const dcrResponse = await fetch(registerEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        software_statement: softwareStatement,
        redirect_uris: [callbackUrl],
        client_name: "Hekatoncheiros Core",
      }),
    });
    if (!dcrResponse.ok) {
      throw new HttpError(400, "OAuth dynamic client registration failed");
    }
    const dcrPayload = (await dcrResponse.json()) as Record<string, unknown>;
    const clientId = String(dcrPayload["client_id"] ?? "");
    if (!clientId) {
      throw new HttpError(400, "OAuth registration did not return client_id");
    }
    const clientSecret = typeof dcrPayload["client_secret"] === "string" ? dcrPayload["client_secret"] : null;
    await upsertOAuthConnection({
      tenantId: params.tenantId,
      issuerUrl: params.issuerUrl,
      appId: params.appId,
      clientId,
      clientSecret,
    });
    connection = { client_id: clientId, client_secret_enc: clientSecret };
  }

  const codeVerifier = randomUUID().replace(/-/g, "");
  const codeChallenge = base64Url(createHash("sha256").update(codeVerifier).digest());
  const state = randomUUID();

  oauthStateStore.set(state, {
    tenantId: params.tenantId,
    issuerUrl: params.issuerUrl,
    appId: params.appId,
    licenseMode: params.licenseMode,
    codeVerifier,
    tokenEndpoint,
    issueEndpoint,
    autoSelect: params.autoSelect ?? false,
    createdAt: Date.now(),
  });

  const callbackUrl = `${loadConfig().LICENSING_OAUTH_CALLBACK_BASE_URL}/api/v1/tenants/${encodeURIComponent(params.tenantId)}/licenses/oauth/callback`;
  const authorizeUrl = new URL(authorizeEndpoint);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", connection.client_id);
  authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
  authorizeUrl.searchParams.set("scope", "license:issue license:read license:bundle");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  return {
    redirect_url: authorizeUrl.toString(),
    state,
  };
}

export async function completeLicenseOAuth(params: {
  tenantId: string;
  code: string;
  state: string;
}): Promise<{ imported: TenantLicenseRecord; auto_selected: boolean }> {
  cleanupOAuthState();
  const flowState = oauthStateStore.get(params.state);
  if (!flowState) {
    throw new HttpError(400, "Invalid oauth state");
  }
  oauthStateStore.delete(params.state);

  if (flowState.tenantId !== params.tenantId) {
    throw new HttpError(400, "OAuth state tenant mismatch");
  }

  const connection = await getOAuthConnection(params.tenantId, flowState.issuerUrl, flowState.appId);
  if (!connection) {
    throw new HttpError(400, "OAuth connection not found");
  }

  const callbackUrl = `${loadConfig().LICENSING_OAUTH_CALLBACK_BASE_URL}/api/v1/tenants/${encodeURIComponent(params.tenantId)}/licenses/oauth/callback`;
  const tokenBody = new URLSearchParams();
  tokenBody.set("grant_type", "authorization_code");
  tokenBody.set("code", params.code);
  tokenBody.set("redirect_uri", callbackUrl);
  tokenBody.set("client_id", connection.client_id);
  tokenBody.set("code_verifier", flowState.codeVerifier);
  if (connection.client_secret_enc) {
    tokenBody.set("client_secret", connection.client_secret_enc);
  }

  const tokenResponse = await fetch(flowState.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody,
  });

  if (!tokenResponse.ok) {
    throw new HttpError(400, "OAuth token exchange failed");
  }

  const tokenPayload = (await tokenResponse.json()) as Record<string, unknown>;
  const accessToken = typeof tokenPayload["access_token"] === "string" ? tokenPayload["access_token"] : "";
  if (!accessToken) {
    throw new HttpError(400, "OAuth token endpoint did not return access_token");
  }

  const platformInstanceId = await getPlatformInstanceAudienceId();
  const issueResponse = await fetch(flowState.issueEndpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      tenant_id: params.tenantId,
      app_id: flowState.appId,
      license_mode: flowState.licenseMode,
      platform_instance_id: platformInstanceId,
    }),
  });

  if (!issueResponse.ok) {
    throw new HttpError(400, "License issuance failed");
  }

  const issuePayload = (await issueResponse.json()) as Record<string, unknown>;
  const licenseJws = typeof issuePayload["license_jws"] === "string" ? issuePayload["license_jws"] : "";
  const authorCertJws =
    typeof issuePayload["author_cert_jws"] === "string"
      ? issuePayload["author_cert_jws"]
      : typeof (issuePayload["bundle"] as Record<string, unknown> | undefined)?.["author_cert_jws"] === "string"
        ? String((issuePayload["bundle"] as Record<string, unknown>)["author_cert_jws"])
        : null;

  if (!licenseJws || !authorCertJws) {
    throw new HttpError(400, "License issue response missing license_jws/author_cert_jws");
  }

  const imported = await importLicenseMaterial({
    tenantId: params.tenantId,
    license_jws: licenseJws,
    author_cert_jws: authorCertJws,
  });

  let autoSelected = false;
  if (flowState.autoSelect && imported.status === "active") {
    await selectTenantLicense(params.tenantId, imported.app_id, imported.jti);
    autoSelected = true;
  }

  return {
    imported,
    auto_selected: autoSelected,
  };
}

export function normalizeImportPayload(body: Record<string, unknown>): {
  license_jws: string;
  author_cert_jws?: string;
} {
  const bundle = body["bundle"] as Record<string, unknown> | undefined;
  if (bundle && typeof bundle === "object") {
    const bundleTyp = bundle["bundle_typ"];
    if (bundleTyp !== "hc-license-bundle") {
      throw new HttpError(400, "Unsupported bundle_typ");
    }
    const license = bundle["license_jws"];
    const cert = bundle["author_cert_jws"];
    if (typeof license !== "string" || typeof cert !== "string") {
      throw new HttpError(400, "bundle.license_jws and bundle.author_cert_jws are required");
    }
    return { license_jws: license, author_cert_jws: cert };
  }

  const licenseJws = body["license_jws"];
  const authorCertJws = body["author_cert_jws"];
  if (typeof licenseJws !== "string" || !licenseJws.trim()) {
    throw new HttpError(400, "license_jws is required");
  }
  if (authorCertJws !== undefined && typeof authorCertJws !== "string") {
    throw new HttpError(400, "author_cert_jws must be string when provided");
  }
  return {
    license_jws: licenseJws,
    author_cert_jws: typeof authorCertJws === "string" ? authorCertJws : undefined,
  };
}

export async function validateStoredLicense(tenantId: string, licenseJti: string): Promise<LicenseValidationResult> {
  const found = await getLicenseByJti(tenantId, licenseJti);
  if (!found) {
    throw new NotFoundError("License not found");
  }

  const result = await validateLicenseMaterial({
    tenantId,
    license_jws: found.license_jws,
    author_cert_jws: found.author_cert_jws,
  });

  return result;
}

export async function mapLegacyAppIdsInMemory(appId: string): Promise<string> {
  if (isValidAuthorScopedAppId(appId)) {
    return appId;
  }
  const { legacyAppIdToAuthorScoped } = await import("./app-id.js");
  const mapped = legacyAppIdToAuthorScoped(appId);
  if (!isValidAuthorScopedAppId(mapped)) {
    throw new HttpError(400, `Unsupported legacy app_id format: ${appId}`);
  }
  return mapped;
}

export function parseLicenseHeader(licenseJws: string): JWSHeaderParameters {
  return decodeProtectedHeader(licenseJws);
}
