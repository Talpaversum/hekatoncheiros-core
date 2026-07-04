import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { findPrivilegeDefinition, PRIVILEGE_CATALOG, tenantScopedPrivileges } from "../../access/privilege-catalog.js";
import { hasPrivilege } from "../../access/privileges.js";
import { recordAudit } from "../../audit/audit-service.js";
import { getPool } from "../../db/pool.js";
import { ForbiddenError, HttpError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

type PrivilegeGrant = {
  privilege: string;
  tenant_id: string | null;
};

const userIdSchema = z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9_-]+$/);

const createUserSchema = z.object({
  id: userIdSchema,
  email: z.string().trim().email().max(255),
  display_name: z.string().trim().max(160).optional().nullable(),
  password: z.string().min(8).max(256),
  status: z.enum(["active", "disabled"]).default("active"),
});

const patchUserSchema = z.object({
  email: z.string().trim().email().max(255).optional(),
  display_name: z.string().trim().max(160).optional().nullable(),
  status: z.enum(["active", "disabled"]).optional(),
});

const resetPasswordSchema = z.object({
  password: z.string().min(8).max(256),
});

const privilegeGrantSchema = z.object({
  privilege: z.string().trim().min(1),
  tenant_id: z.string().trim().min(1).max(80).optional().nullable(),
});

const replacePrivilegesSchema = z.object({
  grants: z.array(privilegeGrantSchema).max(200),
});

const createTenantSchema = z.object({
  id: z.string().trim().min(3).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  name: z.string().trim().min(1).max(160),
  primary_domain: z.string().trim().max(255).optional().nullable(),
  status: z.enum(["active", "disabled"]).default("active"),
});

const patchTenantSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  primary_domain: z.string().trim().max(255).optional().nullable(),
  status: z.enum(["active", "disabled"]).optional(),
});

function hashPassword(password: string) {
  return createHash("sha256").update(password).digest("hex");
}

function requirePlatformSuperadmin(request: { requestContext: { privileges: string[] } }) {
  if (!hasPrivilege(request.requestContext.privileges, "platform.superadmin")) {
    throw new ForbiddenError();
  }
}

function requireTenantConfigManage(request: { requestContext: { privileges: string[] } }) {
  if (!hasPrivilege(request.requestContext.privileges, "tenant.config.manage")) {
    throw new ForbiddenError();
  }
}

function mapGrant(row: Record<string, unknown>): PrivilegeGrant {
  return {
    privilege: String(row["privilege"]),
    tenant_id: (row["tenant_id"] as string | null) ?? null,
  };
}

function mapUser(row: Record<string, unknown>, grants: PrivilegeGrant[] = []) {
  return {
    id: String(row["id"]),
    email: String(row["email"]),
    display_name: (row["display_name"] as string | null) ?? null,
    status: String(row["status"]),
    created_at: new Date(String(row["created_at"])).toISOString(),
    updated_at: new Date(String(row["updated_at"] ?? row["created_at"])).toISOString(),
    privileges: grants,
  };
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

function validatePlatformGrants(grants: PrivilegeGrant[]) {
  const seen = new Set<string>();

  for (const grant of grants) {
    const definition = findPrivilegeDefinition(grant.privilege);
    if (!definition) {
      throw new HttpError(400, `Unknown privilege: ${grant.privilege}`);
    }

    if (definition.scope === "platform" && grant.tenant_id) {
      throw new HttpError(400, `${grant.privilege} must be platform-scoped`);
    }

    const key = `${grant.privilege}:${grant.tenant_id ?? "platform"}`;
    if (seen.has(key)) {
      throw new HttpError(400, `Duplicate privilege grant: ${key}`);
    }
    seen.add(key);
  }
}

function validateTenantGrants(grants: PrivilegeGrant[], tenantId: string) {
  const tenantPrivileges = new Set(tenantScopedPrivileges().map((item) => item.id));
  const seen = new Set<string>();

  for (const grant of grants) {
    if (!tenantPrivileges.has(grant.privilege)) {
      throw new HttpError(400, `${grant.privilege} is not tenant-scoped`);
    }
    if (grant.tenant_id && grant.tenant_id !== tenantId) {
      throw new HttpError(400, "Tenant admins can only manage the current tenant");
    }
    if (seen.has(grant.privilege)) {
      throw new HttpError(400, `Duplicate privilege grant: ${grant.privilege}`);
    }
    seen.add(grant.privilege);
  }
}

async function assertUserExists(userId: string) {
  const pool = getPool();
  const result = await pool.query("select id from core.users where id = $1", [userId]);
  if (!result.rowCount) {
    throw new NotFoundError("User not found");
  }
}

export async function registerIdentityRoutes(app: FastifyInstance) {
  app.get("/rbac/privileges", async (request, reply) => {
    await requireUserAuth(request, app.config);
    return reply.send({ items: PRIVILEGE_CATALOG });
  });

  app.get("/identity/users", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformSuperadmin(request);

    const pool = getPool();
    const users = await pool.query(
      "select id, email, display_name, status, created_at, updated_at from core.users order by email asc",
    );
    const privileges = await pool.query("select user_id, privilege, tenant_id from core.user_privileges order by privilege asc");
    const grantsByUser = new Map<string, PrivilegeGrant[]>();

    for (const row of privileges.rows) {
      const userId = String(row["user_id"]);
      grantsByUser.set(userId, [...(grantsByUser.get(userId) ?? []), mapGrant(row)]);
    }

    return reply.send({
      items: users.rows.map((row) => mapUser(row, grantsByUser.get(String(row["id"])) ?? [])),
    });
  });

  app.post("/identity/users", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformSuperadmin(request);
    const parsed = createUserSchema.parse(request.body);

    const pool = getPool();
    const result = await pool.query(
      `insert into core.users (id, email, display_name, password_hash, status)
       values ($1, $2, $3, $4, $5)
       returning id, email, display_name, status, created_at, updated_at`,
      [parsed.id, parsed.email, parsed.display_name ?? null, hashPassword(parsed.password), parsed.status],
    );

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "identity.user.create",
      objectRef: parsed.id,
      metadata: { email: parsed.email, status: parsed.status },
    });

    return reply.status(201).send(mapUser(result.rows[0]));
  });

  app.patch("/identity/users/:userId", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformSuperadmin(request);
    const params = z.object({ userId: userIdSchema }).parse(request.params);
    const parsed = patchUserSchema.parse(request.body);

    const pool = getPool();
    const result = await pool.query(
      `update core.users
          set email = coalesce($2, email),
              display_name = case when $3 then $4 else display_name end,
              status = coalesce($5, status),
              updated_at = now()
        where id = $1
        returning id, email, display_name, status, created_at, updated_at`,
      [
        params.userId,
        parsed.email ?? null,
        Object.prototype.hasOwnProperty.call(parsed, "display_name"),
        parsed.display_name ?? null,
        parsed.status ?? null,
      ],
    );
    if (!result.rowCount) {
      throw new NotFoundError("User not found");
    }

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "identity.user.update",
      objectRef: params.userId,
      metadata: parsed,
    });

    return reply.send(mapUser(result.rows[0]));
  });

  app.post("/identity/users/:userId/password", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformSuperadmin(request);
    const params = z.object({ userId: userIdSchema }).parse(request.params);
    const parsed = resetPasswordSchema.parse(request.body);

    const pool = getPool();
    const result = await pool.query("update core.users set password_hash = $2, updated_at = now() where id = $1", [
      params.userId,
      hashPassword(parsed.password),
    ]);
    if (!result.rowCount) {
      throw new NotFoundError("User not found");
    }

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "identity.user.password_reset",
      objectRef: params.userId,
      metadata: {},
    });

    return reply.status(204).send();
  });

  app.put("/identity/users/:userId/privileges", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformSuperadmin(request);
    const params = z.object({ userId: userIdSchema }).parse(request.params);
    const parsed = replacePrivilegesSchema.parse(request.body);
    const grants = parsed.grants.map((grant) => ({
      privilege: grant.privilege,
      tenant_id: grant.tenant_id ?? null,
    }));
    validatePlatformGrants(grants);

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("begin");
      const user = await client.query("select id from core.users where id = $1", [params.userId]);
      if (!user.rowCount) {
        throw new NotFoundError("User not found");
      }
      await client.query("delete from core.user_privileges where user_id = $1", [params.userId]);
      for (const grant of grants) {
        await client.query("insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3)", [
          params.userId,
          grant.tenant_id,
          grant.privilege,
        ]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "identity.user.privileges.replace",
      objectRef: params.userId,
      metadata: { grants },
    });

    return reply.send({ user_id: params.userId, grants });
  });

  app.get("/identity/tenants", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformSuperadmin(request);

    const pool = getPool();
    const result = await pool.query("select id, name, primary_domain, status, created_at, updated_at from core.tenants order by name asc");
    return reply.send({ items: result.rows.map(mapTenant) });
  });

  app.post("/identity/tenants", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformSuperadmin(request);
    const parsed = createTenantSchema.parse(request.body);

    const pool = getPool();
    const result = await pool.query(
      `insert into core.tenants (id, name, primary_domain, status)
       values ($1, $2, $3, $4)
       returning id, name, primary_domain, status, created_at, updated_at`,
      [parsed.id, parsed.name, parsed.primary_domain ?? null, parsed.status],
    );

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "identity.tenant.create",
      objectRef: parsed.id,
      metadata: { name: parsed.name, primary_domain: parsed.primary_domain ?? null, status: parsed.status },
    });

    return reply.status(201).send(mapTenant(result.rows[0]));
  });

  app.patch("/identity/tenants/:tenantId", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformSuperadmin(request);
    const params = z.object({ tenantId: userIdSchema }).parse(request.params);
    const parsed = patchTenantSchema.parse(request.body);

    const pool = getPool();
    const result = await pool.query(
      `update core.tenants
          set name = coalesce($2, name),
              primary_domain = case when $3 then $4 else primary_domain end,
              status = coalesce($5, status),
              updated_at = now()
        where id = $1
        returning id, name, primary_domain, status, created_at, updated_at`,
      [
        params.tenantId,
        parsed.name ?? null,
        Object.prototype.hasOwnProperty.call(parsed, "primary_domain"),
        parsed.primary_domain ?? null,
        parsed.status ?? null,
      ],
    );
    if (!result.rowCount) {
      throw new NotFoundError("Tenant not found");
    }

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "identity.tenant.update",
      objectRef: params.tenantId,
      metadata: parsed,
    });

    return reply.send(mapTenant(result.rows[0]));
  });

  app.get("/tenant/users", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantConfigManage(request);

    const pool = getPool();
    const result = await pool.query(
      `select u.id, u.email, u.display_name, u.status, u.created_at, u.updated_at, up.privilege, up.tenant_id
         from core.users u
         join core.user_privileges up on up.user_id = u.id
        where up.tenant_id = $1
        order by u.email asc, up.privilege asc`,
      [request.requestContext.tenant.tenantId],
    );

    const users = new Map<string, { row: Record<string, unknown>; grants: PrivilegeGrant[] }>();
    for (const row of result.rows) {
      const userId = String(row["id"]);
      const current = users.get(userId) ?? { row, grants: [] as PrivilegeGrant[] };
      current.grants.push(mapGrant(row));
      users.set(userId, current);
    }

    return reply.send({ items: [...users.values()].map((item) => mapUser(item.row, item.grants)) });
  });

  app.put("/tenant/users/:userId/privileges", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantConfigManage(request);
    const params = z.object({ userId: userIdSchema }).parse(request.params);
    const parsed = replacePrivilegesSchema.parse(request.body);
    const tenantId = request.requestContext.tenant.tenantId;
    const grants = parsed.grants.map((grant) => ({
      privilege: grant.privilege,
      tenant_id: tenantId,
    }));
    validateTenantGrants(grants, tenantId);
    await assertUserExists(params.userId);

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from core.user_privileges where user_id = $1 and tenant_id = $2", [params.userId, tenantId]);
      for (const grant of grants) {
        await client.query("insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3)", [
          params.userId,
          tenantId,
          grant.privilege,
        ]);
      }
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    await recordAudit({
      tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "tenant.user.privileges.replace",
      objectRef: params.userId,
      metadata: { grants },
    });

    return reply.send({ user_id: params.userId, grants });
  });
}
