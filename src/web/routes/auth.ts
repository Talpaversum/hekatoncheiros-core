import { createHash, randomBytes } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";

import { recordAudit } from "../../audit/audit-service.js";
import { getAuditRequestMetadata } from "../../audit/request-metadata.js";
import { getPool } from "../../db/pool.js";
import { UnauthorizedError } from "../../shared/errors.js";

type LoginRequest = {
  email: string;
  password: string;
};

type RefreshRequest = {
  refresh_token: string;
};

const ACCESS_TOKEN_TTL_SECONDS = 60 * 30;
const REFRESH_TOKEN_TTL_DAYS = 14;

function hashPassword(password: string) {
  return createHash("sha256").update(password).digest("hex");
}

function hashRefreshToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function buildExpiry(secondsFromNow: number) {
  return new Date(Date.now() + secondsFromNow * 1000);
}

async function issueAccessToken({
  userId,
  tenantId,
  config,
}: {
  userId: string;
  tenantId?: string;
  config: FastifyInstance["config"];
}) {
  const secret = new TextEncoder().encode(config.JWT_SECRET);
  const expiresAt = buildExpiry(ACCESS_TOKEN_TTL_SECONDS);
  const jwt = await new SignJWT(tenantId ? { tenant_id: tenantId } : {})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer(config.JWT_ISSUER)
    .setAudience(config.JWT_AUDIENCE_USER)
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret);

  return { jwt, expiresAt };
}

async function issueRefreshToken({ userId }: { userId: string }) {
  const token = randomBytes(48).toString("hex");
  const tokenHash = hashRefreshToken(token);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const pool = getPool();
  await pool.query(
    "insert into core.refresh_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)",
    [userId, tokenHash, expiresAt],
  );

  return { token, expiresAt };
}

async function revokeRefreshToken(tokenHash: string) {
  const pool = getPool();
  await pool.query("update core.refresh_tokens set revoked_at = now() where token_hash = $1", [
    tokenHash,
  ]);
}

async function findUserByEmail(email: string) {
  const pool = getPool();
  const result = await pool.query(
    "select id, email, password_hash, status from core.users where email = $1",
    [email],
  );
  return result.rows[0] as
    | { id: string; email: string; password_hash: string; status: string }
    | undefined;
}

async function findValidRefreshToken(tokenHash: string) {
  const pool = getPool();
  const result = await pool.query(
    "select id, user_id, expires_at, revoked_at from core.refresh_tokens where token_hash = $1",
    [tokenHash],
  );
  return result.rows[0] as
    | { id: string; user_id: string; expires_at: string; revoked_at: string | null }
    | undefined;
}

async function findDefaultTenantForUser(userId: string) {
  const result = await getPool().query(
    `select tenant_id from core.tenant_memberships
      where user_id=$1 and status='active'
      order by created_at limit 1`,
    [userId],
  );
  return result.rowCount ? String(result.rows[0]["tenant_id"]) : undefined;
}

export async function registerAuthRoutes(app: FastifyInstance) {
  app.post<{ Body: LoginRequest }>("/auth/login", async (request, reply) => {
    const { email, password } = request.body;
    const user = await findUserByEmail(email);
    if (!user || user.status !== "active") {
      await recordAudit({
        tenantId: app.config.DEFAULT_TENANT_ID,
        actorType: "anonymous",
        sourceService: "core",
        eventType: "auth.login.failed",
        category: "authentication",
        action: "auth.login",
        outcome: "failure",
        severity: "warning",
        scope: "tenant",
        visibility: "tenant_admin",
        message: "Login failed",
        metadata: { email },
        ...getAuditRequestMetadata(request),
      });
      throw new UnauthorizedError("Invalid credentials");
    }

    const hashed = hashPassword(password);
    if (hashed !== user.password_hash) {
      await recordAudit({
        tenantId: app.config.DEFAULT_TENANT_ID,
        actorType: "anonymous",
        sourceService: "core",
        eventType: "auth.login.failed",
        category: "authentication",
        action: "auth.login",
        outcome: "failure",
        severity: "warning",
        scope: "tenant",
        visibility: "tenant_admin",
        resourceType: "user",
        resourceId: user.id,
        message: "Login failed",
        metadata: { email },
        ...getAuditRequestMetadata(request),
      });
      throw new UnauthorizedError("Invalid credentials");
    }

    const tenantId = await findDefaultTenantForUser(user.id);
    const { jwt, expiresAt } = await issueAccessToken({
      userId: user.id,
      tenantId,
      config: app.config,
    });
    const { token, expiresAt: refreshExpiresAt } = await issueRefreshToken({ userId: user.id });

    await recordAudit({
      tenantId: tenantId ?? app.config.DEFAULT_TENANT_ID,
      actorUserId: user.id,
      effectiveUserId: user.id,
      actorType: "user",
      sourceService: "core",
      eventType: "auth.login.succeeded",
      category: "authentication",
      action: "auth.login",
      outcome: "success",
      severity: "info",
      scope: "user",
      visibility: "user",
      resourceType: "user",
      resourceId: user.id,
      message: "Login succeeded",
      ...getAuditRequestMetadata(request),
    });

    return reply.send({
      access_token: jwt,
      refresh_token: token,
      expires_at: expiresAt.toISOString(),
      refresh_expires_at: refreshExpiresAt.toISOString(),
    });
  });

  app.post<{ Body: RefreshRequest }>("/auth/refresh", async (request, reply) => {
    const { refresh_token } = request.body;
    const tokenHash = hashRefreshToken(refresh_token);
    const stored = await findValidRefreshToken(tokenHash);
    if (!stored || stored.revoked_at) {
      throw new UnauthorizedError("Invalid refresh token");
    }

    if (new Date(stored.expires_at) < new Date()) {
      await revokeRefreshToken(tokenHash);
      throw new UnauthorizedError("Refresh token expired");
    }

    const tenantId = await findDefaultTenantForUser(stored.user_id);
    const { jwt, expiresAt } = await issueAccessToken({
      userId: stored.user_id,
      tenantId,
      config: app.config,
    });

    return reply.send({
      access_token: jwt,
      expires_at: expiresAt.toISOString(),
    });
  });
}
