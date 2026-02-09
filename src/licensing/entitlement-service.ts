import { createHash, randomUUID } from "node:crypto";

import { decodeProtectedHeader, importSPKI, jwtVerify, type JWTPayload } from "jose";

import { loadConfig } from "../config/index.js";
import { getPool } from "../db/pool.js";
import { HttpError, NotFoundError } from "../shared/errors.js";
import { getTierPriority } from "./tier-priority.js";
import { getPlatformInstanceId } from "./platform-instance-service.js";

export interface TenantAppEntitlement {
  id: string;
  tenant_id: string;
  app_id: string;
  source: "ONLINE" | "OFFLINE" | string;
  tier: string;
  valid_from: string;
  valid_to: string;
  limits: Record<string, unknown>;
  status: string;
  created_at: string;
  updated_at: string;
}

export interface ResolvedEntitlement {
  entitlement_id: string;
  tenant_id: string;
  app_id: string;
  source: string;
  tier: string;
  valid_from: string;
  valid_to: string;
  limits: Record<string, unknown>;
}

interface ValidityOptions {
  clockSkewSeconds: number;
  softGraceSeconds: number;
}

function validateTierValue(tier: string) {
  const knownTiers = new Set(["free", "trial", "standard", "enterprise"]);
  if (!knownTiers.has(tier) && getTierPriority(tier) !== -1) {
    throw new HttpError(400, `Invalid tier value: ${tier}`);
  }
}

const defaultConfig = loadConfig();
const defaultValidity: ValidityOptions = {
  clockSkewSeconds: defaultConfig.LICENSING_CLOCK_SKEW_SECONDS,
  softGraceSeconds: defaultConfig.LICENSING_CLOCK_SOFT_GRACE_SECONDS,
};

function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(String(value)).toISOString();
}

function mapEntitlementRow(row: Record<string, unknown>): TenantAppEntitlement {
  return {
    id: String(row["id"]),
    tenant_id: String(row["tenant_id"]),
    app_id: String(row["app_id"]),
    source: String(row["source"]),
    tier: String(row["tier"]),
    valid_from: toIso(row["valid_from"]),
    valid_to: toIso(row["valid_to"]),
    limits: (row["limits"] ?? {}) as Record<string, unknown>,
    status: String(row["status"]),
    created_at: toIso(row["created_at"]),
    updated_at: toIso(row["updated_at"]),
  };
}

function toResolved(entitlement: TenantAppEntitlement): ResolvedEntitlement {
  return {
    entitlement_id: entitlement.id,
    tenant_id: entitlement.tenant_id,
    app_id: entitlement.app_id,
    source: entitlement.source,
    tier: entitlement.tier,
    valid_from: entitlement.valid_from,
    valid_to: entitlement.valid_to,
    limits: entitlement.limits,
  };
}

function evaluateValidityWindow(entitlement: TenantAppEntitlement, now: Date, options: ValidityOptions): "strict" | "soft" | "invalid" {
  if (entitlement.status !== "active") {
    return "invalid";
  }

  const nowMs = now.getTime();
  const validFromMs = new Date(entitlement.valid_from).getTime();
  const validToMs = new Date(entitlement.valid_to).getTime();
  const strictSkewMs = options.clockSkewSeconds * 1000;
  const softSkewMs = options.softGraceSeconds * 1000;

  const strictValid = validFromMs <= nowMs + strictSkewMs && nowMs - strictSkewMs < validToMs;
  if (strictValid) {
    return "strict";
  }

  const softValid = validFromMs <= nowMs + softSkewMs && nowMs - softSkewMs < validToMs;
  return softValid ? "soft" : "invalid";
}

function warnSoftClockSkew(entitlement: TenantAppEntitlement, now: Date) {
  // eslint-disable-next-line no-console
  console.warn(
    `[licensing] Using entitlement in soft grace window. tenant=${entitlement.tenant_id} app=${entitlement.app_id} entitlement=${entitlement.id} now=${now.toISOString()} valid_from=${entitlement.valid_from} valid_to=${entitlement.valid_to}`,
  );
}

function parseUnverifiedPayload(token: string): Record<string, unknown> {
  const chunks = token.split(".");
  if (chunks.length < 2) {
    return {};
  }

  try {
    const json = Buffer.from(chunks[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return parsed;
  } catch {
    return {};
  }
}

function parseOfflineKeyRing(): Record<string, string> {
  const raw = defaultConfig.OFFLINE_LICENSE_PUBLIC_KEYS_JSON;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const output: Record<string, string> = {};
    for (const [kid, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim().length > 0) {
        output[kid] = value;
      }
    }
    return output;
  } catch {
    return {};
  }
}

const TIER_CASE_SQL = "case tier when 'enterprise' then 3 when 'standard' then 2 when 'trial' then 1 when 'free' then 0 else -1 end";
const SOURCE_CASE_SQL = "case source when 'OFFLINE' then 1 when 'ONLINE' then 0 else -1 end";

async function findBestEntitlement(tenantId: string, appId: string, now: Date, skewSeconds: number): Promise<TenantAppEntitlement | null> {
  const pool = getPool();
  const result = await pool.query(
    `select id, tenant_id, app_id, source, tier, valid_from, valid_to, limits, status, created_at, updated_at
     from core.tenant_app_entitlements
     where tenant_id = $1
       and app_id = $2
       and status = 'active'
       and valid_from <= ($3::timestamptz + ($4 * interval '1 second'))
       and valid_to > ($3::timestamptz - ($4 * interval '1 second'))
     order by ${SOURCE_CASE_SQL} desc, ${TIER_CASE_SQL} desc, valid_to desc, created_at desc, id desc
     limit 1`,
    [tenantId, appId, now.toISOString(), skewSeconds],
  );

  if ((result.rowCount ?? 0) === 0) {
    return null;
  }

  return mapEntitlementRow(result.rows[0] as Record<string, unknown>);
}

async function readSelectedEntitlement(tenantId: string, appId: string): Promise<TenantAppEntitlement | null> {
  const pool = getPool();
  const result = await pool.query(
    `select e.id, e.tenant_id, e.app_id, e.source, e.tier, e.valid_from, e.valid_to, e.limits, e.status, e.created_at, e.updated_at
     from core.tenant_app_selection s
     join core.tenant_app_entitlements e on e.id = s.selected_entitlement_id
     where s.tenant_id = $1 and s.app_id = $2
     limit 1`,
    [tenantId, appId],
  );

  if ((result.rowCount ?? 0) === 0) {
    return null;
  }

  return mapEntitlementRow(result.rows[0] as Record<string, unknown>);
}

export async function listEntitlements(tenantId: string, appId: string): Promise<TenantAppEntitlement[]> {
  const pool = getPool();
  const result = await pool.query(
    `select id, tenant_id, app_id, source, tier, valid_from, valid_to, limits, status, created_at, updated_at
     from core.tenant_app_entitlements
     where tenant_id = $1 and app_id = $2
     order by created_at desc, id desc`,
    [tenantId, appId],
  );

  return result.rows.map((row) => mapEntitlementRow(row as Record<string, unknown>));
}

export async function getSelectedEntitlementId(tenantId: string, appId: string): Promise<string | null> {
  const pool = getPool();
  const selected = await pool.query(
    "select selected_entitlement_id from core.tenant_app_selection where tenant_id = $1 and app_id = $2",
    [tenantId, appId],
  );

  return (selected.rowCount ?? 0) > 0 ? String(selected.rows[0].selected_entitlement_id) : null;
}

export async function hasAnyEntitlement(tenantId: string, appId: string): Promise<boolean> {
  const pool = getPool();
  const result = await pool.query(
    "select 1 from core.tenant_app_entitlements where tenant_id = $1 and app_id = $2 limit 1",
    [tenantId, appId],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function setSelectedEntitlement(tenantId: string, appId: string, entitlementId: string): Promise<void> {
  const pool = getPool();
  const entitlement = await pool.query(
    "select 1 from core.tenant_app_entitlements where id = $1 and tenant_id = $2 and app_id = $3",
    [entitlementId, tenantId, appId],
  );

  if ((entitlement.rowCount ?? 0) === 0) {
    throw new NotFoundError("Entitlement not found for tenant/app");
  }

  await pool.query(
    `insert into core.tenant_app_selection (tenant_id, app_id, selected_entitlement_id, selected_at)
     values ($1, $2, $3, now())
     on conflict (tenant_id, app_id)
     do update set selected_entitlement_id = excluded.selected_entitlement_id, selected_at = now()`,
    [tenantId, appId, entitlementId],
  );
}

export async function clearSelectedEntitlement(tenantId: string, appId: string): Promise<void> {
  const pool = getPool();
  await pool.query("delete from core.tenant_app_selection where tenant_id = $1 and app_id = $2", [tenantId, appId]);
}

export async function resolveEntitlement(
  tenantId: string,
  appId: string,
  now: Date = new Date(),
  options: Partial<ValidityOptions> = {},
): Promise<ResolvedEntitlement | null> {
  const validityOptions: ValidityOptions = {
    clockSkewSeconds: options.clockSkewSeconds ?? defaultValidity.clockSkewSeconds,
    softGraceSeconds: options.softGraceSeconds ?? defaultValidity.softGraceSeconds,
  };

  const selected = await readSelectedEntitlement(tenantId, appId);
  if (selected) {
    const selectedValidity = evaluateValidityWindow(selected, now, validityOptions);
    if (selectedValidity === "strict") {
      return toResolved(selected);
    }
    if (selectedValidity === "soft") {
      warnSoftClockSkew(selected, now);
      return toResolved(selected);
    }
  }

  const strict = await findBestEntitlement(tenantId, appId, now, validityOptions.clockSkewSeconds);
  if (strict) {
    return toResolved(strict);
  }

  const soft = await findBestEntitlement(tenantId, appId, now, validityOptions.softGraceSeconds);
  if (soft) {
    warnSoftClockSkew(soft, now);
    return toResolved(soft);
  }

  return null;
}

export async function upsertOnlineEntitlement(params: {
  tenantId: string;
  appId: string;
  tier: string;
  validFrom: string;
  validTo: string;
  limits?: Record<string, unknown>;
}): Promise<TenantAppEntitlement> {
  validateTierValue(params.tier);
  const pool = getPool();

  const existing = await pool.query(
    `select id
     from core.tenant_app_entitlements
     where tenant_id = $1 and app_id = $2 and source = 'ONLINE' and tier = $3 and valid_from = $4::timestamptz and valid_to = $5::timestamptz
     limit 1`,
    [params.tenantId, params.appId, params.tier, params.validFrom, params.validTo],
  );

  let id: string;
  if ((existing.rowCount ?? 0) > 0) {
    id = String(existing.rows[0].id);
    await pool.query(
      `update core.tenant_app_entitlements
       set limits = $2::jsonb, status = 'active', updated_at = now()
       where id = $1`,
      [id, JSON.stringify(params.limits ?? {})],
    );
  } else {
    const inserted = await pool.query(
      `insert into core.tenant_app_entitlements
       (tenant_id, app_id, source, tier, valid_from, valid_to, limits, status)
       values ($1, $2, 'ONLINE', $3, $4::timestamptz, $5::timestamptz, $6::jsonb, 'active')
       returning id`,
      [params.tenantId, params.appId, params.tier, params.validFrom, params.validTo, JSON.stringify(params.limits ?? {})],
    );
    id = String(inserted.rows[0].id);
  }

  const row = await pool.query(
    `select id, tenant_id, app_id, source, tier, valid_from, valid_to, limits, status, created_at, updated_at
     from core.tenant_app_entitlements
     where id = $1`,
    [id],
  );

  return mapEntitlementRow(row.rows[0] as Record<string, unknown>);
}

export interface OfflineTokenIngestResult {
  entitlement: TenantAppEntitlement;
  verification_result: string;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function requireClaim(payload: JWTPayload, key: string): string {
  const value = payload[key];
  if (!isString(value)) {
    throw new HttpError(400, `Missing claim: ${key}`);
  }
  return value;
}

export async function ingestOfflineToken(params: { tenantId: string; token: string }): Promise<OfflineTokenIngestResult> {
  const pool = getPool();
  const tokenHash = createHash("sha256").update(params.token).digest("hex");
  const unverified = parseUnverifiedPayload(params.token);
  const fallbackAppId = isString(unverified["app_id"]) ? String(unverified["app_id"]) : "unknown_app";

  try {
    const protectedHeader = decodeProtectedHeader(params.token);
    const kid =
      isString(protectedHeader.kid) ? protectedHeader.kid : isString(unverified["kid"]) ? String(unverified["kid"]) : null;
    if (!kid) {
      throw new HttpError(400, "Missing kid in token header/claims");
    }

    const keyRing = parseOfflineKeyRing();
    const pem = keyRing[kid];
    if (!pem) {
      throw new HttpError(400, `Unknown kid: ${kid}`);
    }

    const alg = isString(protectedHeader.alg) ? protectedHeader.alg : "RS256";
    const key = await importSPKI(pem, alg);
    const platformInstanceId = await getPlatformInstanceId();

    const verified = await jwtVerify(params.token, key, {
      audience: platformInstanceId,
      clockTolerance: defaultValidity.clockSkewSeconds,
    });

    const payload = verified.payload;
    const tenantId = requireClaim(payload, "tenant_id");
    const appId = requireClaim(payload, "app_id");
    const tier = requireClaim(payload, "tier");
    const validFrom = requireClaim(payload, "valid_from");
    const validTo = requireClaim(payload, "valid_to");
    const issuer = requireClaim(payload, "iss");
    const jti = requireClaim(payload, "jti");
    const claimKid = isString(payload["kid"]) ? payload["kid"] : kid;

    if (tenantId !== params.tenantId) {
      throw new HttpError(400, "tenant_id claim does not match current tenant");
    }

    validateTierValue(tier);

    const limits = (payload["limits"] ?? {}) as Record<string, unknown>;
    const provisional: TenantAppEntitlement = {
      id: "provisional",
      tenant_id: tenantId,
      app_id: appId,
      source: "OFFLINE",
      tier,
      valid_from: new Date(validFrom).toISOString(),
      valid_to: new Date(validTo).toISOString(),
      limits,
      status: "active",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const validity = evaluateValidityWindow(provisional, new Date(), defaultValidity);
    let verificationResult = "ok";
    if (validity === "invalid") {
      verificationResult = "ok_with_time_warning";
      warnSoftClockSkew(provisional, new Date());
    } else if (validity === "soft") {
      verificationResult = "ok_with_time_warning";
      warnSoftClockSkew(provisional, new Date());
    }

    const existing = await pool.query(
      `select id
       from core.tenant_app_entitlements
       where tenant_id = $1 and app_id = $2 and source = 'OFFLINE' and tier = $3 and valid_from = $4::timestamptz and valid_to = $5::timestamptz
       limit 1`,
      [tenantId, appId, tier, validFrom, validTo],
    );

    let entitlementId: string;
    if ((existing.rowCount ?? 0) > 0) {
      entitlementId = String(existing.rows[0].id);
      await pool.query(
        `update core.tenant_app_entitlements
         set limits = $2::jsonb, status = 'active', updated_at = now()
         where id = $1`,
        [entitlementId, JSON.stringify(limits)],
      );
    } else {
      const inserted = await pool.query(
        `insert into core.tenant_app_entitlements
         (tenant_id, app_id, source, tier, valid_from, valid_to, limits, status)
         values ($1, $2, 'OFFLINE', $3, $4::timestamptz, $5::timestamptz, $6::jsonb, 'active')
         returning id`,
        [tenantId, appId, tier, validFrom, validTo, JSON.stringify(limits)],
      );
      entitlementId = String(inserted.rows[0].id);
    }

    await pool.query(
      `insert into core.offline_license_tokens
       (id, tenant_id, app_id, kid, token_hash, claims, verification_result, last_verified_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, now())`,
      [
        randomUUID(),
        tenantId,
        appId,
        claimKid,
        tokenHash,
        JSON.stringify({ ...payload, kid: claimKid, iss: issuer, jti }),
        verificationResult,
      ],
    );

    const row = await pool.query(
      `select id, tenant_id, app_id, source, tier, valid_from, valid_to, limits, status, created_at, updated_at
       from core.tenant_app_entitlements
       where id = $1`,
      [entitlementId],
    );

    return {
      entitlement: mapEntitlementRow(row.rows[0] as Record<string, unknown>),
      verification_result: verificationResult,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "verification_failed";
    const kid = isString(unverified["kid"]) ? String(unverified["kid"]) : "unknown_kid";
    await pool.query(
      `insert into core.offline_license_tokens
       (id, tenant_id, app_id, kid, token_hash, claims, verification_result, last_verified_at)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7, now())`,
      [
        randomUUID(),
        params.tenantId,
        fallbackAppId,
        kid,
        tokenHash,
        JSON.stringify(unverified),
        `error:${message}`,
      ],
    );
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(400, "Offline token verification failed");
  }
}
