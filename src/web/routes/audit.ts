import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import {
  AUDIT_OUTCOMES,
  AUDIT_SCOPES,
  AUDIT_SEVERITIES,
  AUDIT_VISIBILITIES,
  recordAudit,
} from "../../audit/audit-service.js";
import { getAuditRequestMetadata } from "../../audit/request-metadata.js";
import { getPool } from "../../db/pool.js";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../../shared/errors.js";
import { requireAppAuth } from "../plugins/auth-app.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const identifier = z.string().trim().min(1).max(160).regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
const writeSchema = z.object({
  event_type: identifier,
  category: identifier,
  action: z.string().trim().min(1).max(160),
  outcome: z.enum(AUDIT_OUTCOMES),
  severity: z.enum(AUDIT_SEVERITIES),
  scope: z.enum(AUDIT_SCOPES),
  visibility: z.enum(AUDIT_VISIBILITIES),
  resource_type: z.string().trim().max(160).optional().nullable(),
  resource_id: z.string().trim().max(500).optional().nullable(),
  object_ref: z.string().trim().max(500).optional().nullable(),
  message: z.string().trim().min(1).max(4096),
  metadata: z.record(z.string(), z.unknown()).optional(),
  correlation_id: z.string().trim().max(128).optional().nullable(),
  occurred_at: z.coerce.date().optional(),
});

export type AuditReadAccess = { mode: "platform" | "tenant" | "own"; tenantId: string | null; userId: string };

async function requireAuditRead(request: FastifyRequest, config: FastifyInstance["config"]): Promise<AuditReadAccess> {
  await requireUserAuth(request, config);
  const privileges = request.requestContext.privileges;
  if (hasPrivilege(privileges, "platform.audit.read")) {
    return { mode: "platform", tenantId: null, userId: request.requestContext.actor.effectiveUserId };
  }
  const tenantId = request.requestContext.tenant.tenantId;
  if (hasPrivilege(privileges, "core.audit.read.tenant")) {
    return { mode: "tenant", tenantId, userId: request.requestContext.actor.effectiveUserId };
  }
  if (hasPrivilege(privileges, "core.audit.read.own")) {
    return { mode: "own", tenantId, userId: request.requestContext.actor.effectiveUserId };
  }
  throw new ForbiddenError();
}

function list(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))].slice(0, 100);
}

function visibilitySql(access: AuditReadAccess, values: unknown[], index: number): string {
  if (access.mode === "platform") return "true";
  values.push(access.tenantId);
  const tenantParam = `$${index++}`;
  if (access.mode === "tenant") return `tenant_id = ${tenantParam} and visibility in ('user','tenant_admin') and scope <> 'platform'`;
  values.push(access.userId);
  return `tenant_id = ${tenantParam} and visibility = 'user' and scope <> 'platform' and
    (actor_user_id = $${index} or effective_user_id = $${index} or (resource_type = 'user' and resource_id = $${index}))`;
}

export function encodeAuditCursor(row: Record<string, unknown>) {
  return Buffer.from(JSON.stringify([row["occurred_at"], row["id"]])).toString("base64url");
}

export function decodeAuditCursor(cursor: string): [string, string] {
  const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  if (!Array.isArray(decoded) || decoded.length !== 2 || decoded.some((item) => typeof item !== "string")) throw new Error();
  return decoded as [string, string];
}

export function buildAuditWhere(query: Record<string, unknown>, access: AuditReadAccess) {
  const values: unknown[] = [];
  const clauses = [visibilitySql(access, values, 1)];
  const add = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace("?", `$${values.length}`)); };
  if (typeof query["from"] === "string") add("occurred_at >= ?", query["from"]);
  if (typeof query["to"] === "string") add("occurred_at <= ?", query["to"]);
  const multi: Record<string, string> = {
    tenant_id: "tenant_id", user_id: "coalesce(effective_user_id, actor_user_id)", application_id: "application_id",
    event_type: "event_type", category: "category", severity: "severity", outcome: "outcome", scope: "scope",
  };
  for (const [key, column] of Object.entries(multi)) {
    const selected = list(query[key]);
    if (selected.length) add(`${column} = any(?)`, selected);
  }
  for (const key of ["resource_type", "resource_id", "correlation_id"] as const) {
    if (typeof query[key] === "string" && query[key]) add(`${key} = ?`, query[key]);
  }
  if (access.mode !== "platform" && list(query["tenant_id"]).some((id) => id !== access.tenantId)) throw new ForbiddenError();
  if (access.mode === "own" && list(query["user_id"]).some((id) => id !== access.userId)) throw new ForbiddenError();
  return { clauses, values };
}

async function appendEvent(request: FastifyRequest, app: FastifyInstance) {
  const body = writeSchema.parse(request.body);
  const metadata = getAuditRequestMetadata(request);
  const authHeader = request.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) throw new UnauthorizedError();

  try {
    await requireAppAuth(request, app.config);
    const claims = request.appClaims!;
    if (!claims.privileges?.includes("core.audit.append")) throw new ForbiddenError();
    if (!claims.tenant_id || body.scope === "platform" || body.visibility === "platform_admin") throw new ForbiddenError();
    await recordAudit({
      tenantId: claims.tenant_id, actorType: "application", applicationId: claims.app_id,
      sourceService: claims.app_id, eventType: body.event_type, category: body.category,
      action: body.action, outcome: body.outcome, severity: body.severity, scope: body.scope,
      visibility: body.visibility, resourceType: body.resource_type, resourceId: body.resource_id,
      objectRef: body.object_ref, message: body.message, metadata: body.metadata,
      correlationId: body.correlation_id ?? metadata.correlationId, requestId: metadata.requestId,
      ipAddress: metadata.ipAddress, userAgent: metadata.userAgent, occurredAt: body.occurred_at,
    });
    return;
  } catch (error) {
    if (error instanceof ForbiddenError) throw error;
  }

  await requireUserAuth(request, app.config);
  if (!hasPrivilege(request.requestContext.privileges, "core.audit.append")) throw new ForbiddenError();
  if (body.scope === "platform" && !hasPrivilege(request.requestContext.privileges, "platform.audit.read")) throw new ForbiddenError();
  const actor = request.requestContext.actor;
  await recordAudit({
    tenantId: body.scope === "platform" ? null : request.requestContext.tenant.tenantId,
    actorUserId: actor.userId, effectiveUserId: actor.effectiveUserId, actorType: "user", sourceService: "core",
    eventType: body.event_type, category: body.category, action: body.action, outcome: body.outcome,
    severity: body.severity, scope: body.scope, visibility: body.visibility,
    resourceType: body.resource_type, resourceId: body.resource_id, objectRef: body.object_ref,
    message: body.message, metadata: body.metadata, correlationId: body.correlation_id ?? metadata.correlationId,
    requestId: metadata.requestId, ipAddress: metadata.ipAddress, userAgent: metadata.userAgent,
    occurredAt: body.occurred_at,
  });
}

export async function registerAuditRoutes(app: FastifyInstance) {
  app.post("/audit/events", async (request, reply) => { await appendEvent(request, app); return reply.code(204).send(); });
  app.post("/audit/record", async (request, reply) => {
    const legacy = request.body as { action: string; object_ref: string; metadata?: Record<string, unknown> };
    request.body = { event_type: legacy.action, category: "audit", action: legacy.action, outcome: "unknown", severity: "info", scope: "tenant", visibility: "tenant_admin", resource_id: legacy.object_ref, object_ref: legacy.object_ref, message: legacy.action, metadata: legacy.metadata };
    await appendEvent(request, app);
    return reply.code(204).send();
  });

  app.get("/audit/events", async (request) => {
    const access = await requireAuditRead(request, app.config);
    const query = request.query as Record<string, unknown>;
    const { clauses, values } = buildAuditWhere(query, access);
    if (typeof query["cursor"] === "string" && query["cursor"]) {
      let cursor: [string, string];
      try { cursor = decodeAuditCursor(query["cursor"]); } catch { throw new Error("Invalid audit cursor"); }
      values.push(cursor[0], cursor[1]);
      clauses.push(`(occurred_at, id) < ($${values.length - 1}::timestamptz, $${values.length}::uuid)`);
    }
    const limit = Math.min(Math.max(Number(query["limit"] ?? 50) || 50, 1), 200);
    values.push(limit + 1);
    const result = await getPool().query(`select * from core.audit_log where ${clauses.join(" and ")} order by occurred_at desc, id desc limit $${values.length}`, values);
    const hasNext = result.rows.length > limit;
    const items = result.rows.slice(0, limit);
    return { items, next_cursor: hasNext ? encodeAuditCursor(items[items.length - 1] as Record<string, unknown>) : null };
  });

  app.get("/audit/events/:id", async (request) => {
    const access = await requireAuditRead(request, app.config);
    const { clauses, values } = buildAuditWhere({}, access);
    values.push((request.params as { id: string }).id);
    const result = await getPool().query(`select * from core.audit_log where ${clauses.join(" and ")} and id = $${values.length}::uuid`, values);
    if (!result.rows[0]) throw new NotFoundError("Audit event not found");
    return result.rows[0];
  });

  app.get("/audit/filter-options", async (request) => {
    const access = await requireAuditRead(request, app.config);
    const { clauses, values } = buildAuditWhere({}, access);
    const where = clauses.join(" and ");
    const result = await getPool().query(`select
      coalesce(jsonb_agg(distinct tenant_id) filter (where tenant_id is not null), '[]') tenants,
      coalesce(jsonb_agg(distinct coalesce(effective_user_id, actor_user_id)) filter (where coalesce(effective_user_id, actor_user_id) is not null), '[]') users,
      coalesce(jsonb_agg(distinct application_id) filter (where application_id is not null), '[]') applications,
      coalesce(jsonb_agg(distinct category), '[]') categories,
      coalesce(jsonb_agg(distinct event_type), '[]') event_types
      from core.audit_log where ${where}`, values);
    const row = result.rows[0];
    return { ...row, tenants: access.mode === "platform" ? row.tenants : [], severities: AUDIT_SEVERITIES, outcomes: AUDIT_OUTCOMES };
  });
}
