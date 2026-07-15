import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { recordAudit } from "../../audit/audit-service.js";
import { getPool } from "../../db/pool.js";
import { getPlatformInstanceId } from "../../licensing/platform-instance-service.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const patchTenantSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  primary_domain: z.string().trim().max(255).optional().nullable(),
});

const patchPlatformSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  public_base_url: z.string().trim().url().optional().nullable(),
  runtime_health_interval_ms: z.number().int().min(1000).max(300000).optional(),
  runtime_health_timeout_ms: z.number().int().min(100).max(30000).optional(),
  runtime_health_failure_threshold: z.number().int().min(1).max(10).optional(),
});

function requireTenantConfigManage(request: { requestContext: { privileges: string[] } }) {
  if (!hasPrivilege(request.requestContext.privileges, "tenant.config.manage")) {
    throw new ForbiddenError();
  }
}

function requirePlatformSuperadmin(request: { requestContext: { privileges: string[] } }) {
  if (!hasPrivilege(request.requestContext.privileges, "platform.superadmin")) {
    throw new ForbiddenError();
  }
}

function mapTenant(row: Record<string, unknown>) {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    primary_domain: (row["primary_domain"] as string | null) ?? null,
    status: String(row["status"]),
    created_at: new Date(String(row["created_at"])).toISOString(),
    updated_at: new Date(String(row["updated_at"] ?? row["created_at"])).toISOString(),
  };
}

function mapPlatform(row: Record<string, unknown>) {
  return {
    instance_id: String(row["instance_id"]),
    name: String(row["name"]),
    public_base_url: (row["public_base_url"] as string | null) ?? null,
    runtime_health_interval_ms: Number(row["runtime_health_interval_ms"] ?? 5000),
    runtime_health_timeout_ms: Number(row["runtime_health_timeout_ms"] ?? 1500),
    runtime_health_failure_threshold: Number(row["runtime_health_failure_threshold"] ?? 2),
    updated_at: new Date(String(row["updated_at"])).toISOString(),
  };
}

export async function registerConfigurationRoutes(app: FastifyInstance) {
  app.get("/tenant", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantConfigManage(request);

    const pool = getPool();
    const result = await pool.query(
      "select id, name, primary_domain, status, created_at, updated_at from core.tenants where id = $1",
      [request.requestContext.tenant.tenantId],
    );
    if (!result.rowCount) {
      throw new NotFoundError("Tenant not found");
    }

    return reply.send(mapTenant(result.rows[0]));
  });

  app.patch("/tenant", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantConfigManage(request);
    const parsed = patchTenantSchema.parse(request.body);

    const pool = getPool();
    const result = await pool.query(
      `update core.tenants
          set name = coalesce($2, name),
              primary_domain = case when $3 then $4 else primary_domain end,
              updated_at = now()
        where id = $1
        returning id, name, primary_domain, status, created_at, updated_at`,
      [
        request.requestContext.tenant.tenantId,
        parsed.name ?? null,
        Object.prototype.hasOwnProperty.call(parsed, "primary_domain"),
        parsed.primary_domain ?? null,
      ],
    );
    if (!result.rowCount) {
      throw new NotFoundError("Tenant not found");
    }

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "tenant.config.update",
      objectRef: request.requestContext.tenant.tenantId,
      metadata: parsed,
    });

    return reply.send(mapTenant(result.rows[0]));
  });

  app.get("/platform/instance", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformSuperadmin(request);

    const instanceId = await getPlatformInstanceId();
    const pool = getPool();
    const result = await pool.query(
      "select instance_id, name, public_base_url, runtime_health_interval_ms, runtime_health_timeout_ms, runtime_health_failure_threshold, updated_at from core.platform_instance where instance_id = $1",
      [instanceId],
    );

    if (!result.rowCount) {
      throw new NotFoundError("Platform instance not found");
    }

    return reply.send(mapPlatform(result.rows[0]));
  });

  app.patch("/platform/instance", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformSuperadmin(request);
    const parsed = patchPlatformSchema.parse(request.body);

    const instanceId = await getPlatformInstanceId();
    const pool = getPool();
    const result = await pool.query(
      `update core.platform_instance
          set name = coalesce($2, name),
              public_base_url = case when $3 then $4 else public_base_url end,
              runtime_health_interval_ms = coalesce($5, runtime_health_interval_ms),
              runtime_health_timeout_ms = coalesce($6, runtime_health_timeout_ms),
              runtime_health_failure_threshold = coalesce($7, runtime_health_failure_threshold),
              updated_at = now()
        where instance_id = $1
        returning instance_id, name, public_base_url, runtime_health_interval_ms, runtime_health_timeout_ms, runtime_health_failure_threshold, updated_at`,
      [
        instanceId,
        parsed.name ?? null,
        Object.prototype.hasOwnProperty.call(parsed, "public_base_url"),
        parsed.public_base_url ?? null,
        parsed.runtime_health_interval_ms ?? null,
        parsed.runtime_health_timeout_ms ?? null,
        parsed.runtime_health_failure_threshold ?? null,
      ],
    );

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "platform.instance.update",
      objectRef: instanceId,
      metadata: parsed,
    });

    return reply.send(mapPlatform(result.rows[0]));
  });
}
