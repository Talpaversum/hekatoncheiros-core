import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { PRIVILEGE_CATALOG } from "../../access/privilege-catalog.js";
import { hasPrivilege } from "../../access/privileges.js";
import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { recordAudit } from "../../audit/audit-service.js";
import { getPool } from "../../db/pool.js";
import { generateDatabaseIdentifier, userSlugSource } from "../../identity/generated-id.js";
import { createTenantMembership, provisionSystemTenantRoles } from "../../identity/tenant-rbac.js";
import { ForbiddenError, HttpError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

type PrivilegeGrant = {
  privilege: string;
  tenant_id: string | null;
};

const userIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(80)
  .regex(/^[a-zA-Z0-9_-]+$/);

const createUserSchema = z.object({
  email: z.string().trim().email().max(255),
  display_name: z.string().trim().min(1).max(160).optional().nullable(),
  nickname: z.string().trim().min(1).max(80).optional().nullable(),
  password: z.string().min(8).max(256),
  status: z.enum(["active", "disabled"]).default("active"),
  memberships: z
    .array(
      z.object({
        tenant_id: userIdSchema,
        role_ids: z.array(z.string().uuid()).max(20).optional(),
        role_keys: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
      }),
    )
    .max(50)
    .default([]),
});

const patchUserSchema = z.object({
  email: z.string().trim().email().max(255).optional(),
  display_name: z.string().trim().max(160).optional().nullable(),
  nickname: z.string().trim().max(80).optional().nullable(),
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
  name: z.string().trim().min(1).max(160),
  primary_domain: z
    .string()
    .trim()
    .max(255)
    .regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i)
    .optional()
    .nullable(),
  status: z.enum(["active", "disabled"]).default("active"),
  first_admin_user_id: userIdSchema.optional().nullable(),
});

const patchTenantSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  primary_domain: z.string().trim().max(255).optional().nullable(),
  status: z.enum(["active", "disabled"]).optional(),
});

const createMembershipSchema = z.object({
  tenant_id: userIdSchema.optional(),
  user_id: userIdSchema,
  status: z.enum(["active", "inactive"]).default("active"),
  role_ids: z.array(z.string().uuid()).max(20).default([]),
});
const patchMembershipSchema = z.object({
  status: z.enum(["active", "inactive"]),
  version: z.number().int().positive(),
});
const membershipParamsSchema = z.object({ membershipId: z.string().uuid() });
const membershipRoleParamsSchema = membershipParamsSchema.extend({ roleId: z.string().uuid() });
const createRoleSchema = z.object({
  key: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z][a-z0-9_]*$/),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().max(500).default(""),
  privileges: z.array(z.string().trim().min(1)).max(200).default([]),
});
const patchRoleSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  description: z.string().trim().max(500).optional(),
  version: z.number().int().positive(),
});
const roleParamsSchema = z.object({ roleId: z.string().uuid() });
const rolePrivilegeParamsSchema = roleParamsSchema.extend({
  privilegeKey: z.string().trim().min(1).max(200),
});

function hashPassword(password: string) {
  return createHash("sha256").update(password).digest("hex");
}

function requirePlatformPrivilege(
  request: { requestContext: { privileges: string[] } },
  privilege: string,
) {
  if (!hasPrivilege(request.requestContext.privileges, privilege)) throw new ForbiddenError();
}

function requireTenantPrivilege(
  request: { requestContext: { privileges: string[] } },
  privilege: string,
) {
  if (!hasPrivilege(request.requestContext.privileges, privilege)) throw new ForbiddenError();
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
    nickname: (row["nickname"] as string | null) ?? null,
    status: String(row["status"]),
    created_at: new Date(String(row["created_at"])).toISOString(),
    updated_at: new Date(String(row["updated_at"] ?? row["created_at"])).toISOString(),
    privileges: grants,
    memberships: Array.isArray(row["memberships"]) ? row["memberships"] : [],
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

async function loadMemberships(filters: { userId?: string; tenantId?: string } = {}) {
  const pool = getPool();
  const result = await pool.query(
    `select tm.id, tm.tenant_id, tm.user_id, tm.status, tm.version, tm.created_at, tm.updated_at,
            t.name as tenant_name,
            coalesce((select jsonb_agg(jsonb_build_object(
              'id', tr.id, 'key', tr.key, 'name', tr.name, 'description', tr.description,
              'is_system', tr.is_system, 'version', tr.version
            ) order by tr.name)
              from core.tenant_member_roles tmr
              join core.tenant_roles tr on tr.id=tmr.role_id
             where tmr.tenant_membership_id=tm.id), '[]'::jsonb) as roles,
            coalesce((select jsonb_agg(up.privilege order by up.privilege)
              from core.user_privileges up
             where up.user_id=tm.user_id and up.tenant_id=tm.tenant_id), '[]'::jsonb) as direct_privileges,
            coalesce((select jsonb_agg(distinct effective.privilege order by effective.privilege)
              from (
                select up.privilege from core.user_privileges up
                 where up.user_id=tm.user_id and up.tenant_id=tm.tenant_id
                union
                select rp.privilege_key from core.tenant_member_roles tmr
                 join core.role_privileges rp on rp.role_id=tmr.role_id
                 where tmr.tenant_membership_id=tm.id
              ) effective(privilege)), '[]'::jsonb) as effective_privileges
       from core.tenant_memberships tm
       join core.tenants t on t.id=tm.tenant_id
      where ($1::text is null or tm.user_id=$1)
        and ($2::text is null or tm.tenant_id=$2)
      order by t.name, tm.created_at`,
    [filters.userId ?? null, filters.tenantId ?? null],
  );
  return result.rows.map((row) => ({
    id: String(row["id"]),
    tenant_id: String(row["tenant_id"]),
    tenant_name: String(row["tenant_name"]),
    user_id: String(row["user_id"]),
    status: String(row["status"]),
    version: Number(row["version"]),
    roles: row["roles"] as unknown[],
    direct_privileges: row["direct_privileges"] as string[],
    effective_privileges: row["effective_privileges"] as string[],
    created_at: new Date(String(row["created_at"])).toISOString(),
    updated_at: new Date(String(row["updated_at"])).toISOString(),
  }));
}

async function loadRoles(tenantId: string) {
  const result = await getPool().query(
    `select tr.id, tr.tenant_id, tr.key, tr.name, tr.description, tr.is_system, tr.version,
            tr.created_at, tr.updated_at,
            coalesce((select jsonb_agg(rp.privilege_key order by rp.privilege_key)
              from core.role_privileges rp where rp.role_id=tr.id), '[]'::jsonb) privileges,
            (select count(*)::int from core.tenant_member_roles tmr where tmr.role_id=tr.id) member_count
       from core.tenant_roles tr where tr.tenant_id=$1 order by tr.is_system desc, tr.name`,
    [tenantId],
  );
  return result.rows.map((row) => ({
    id: String(row["id"]),
    tenant_id: String(row["tenant_id"]),
    key: String(row["key"]),
    name: String(row["name"]),
    description: String(row["description"]),
    is_system: Boolean(row["is_system"]),
    version: Number(row["version"]),
    privileges: row["privileges"] as string[],
    member_count: Number(row["member_count"]),
    created_at: new Date(String(row["created_at"])).toISOString(),
    updated_at: new Date(String(row["updated_at"])).toISOString(),
  }));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

async function listPrivilegeDefinitions() {
  const definitions = new Map(PRIVILEGE_CATALOG.map((item) => [item.id, item]));
  const installedApps = await getAppInstallationStore().listInstalledApps();

  for (const app of installedApps) {
    const manifest = app.manifest as Record<string, unknown>;
    const appName = typeof manifest["app_name"] === "string" ? manifest["app_name"] : app.app_id;
    const privileges = manifest["privileges"] as
      | { required?: unknown; optional?: unknown }
      | undefined;
    const ids = [
      ...readStringArray(privileges?.required),
      ...readStringArray(privileges?.optional),
    ];

    for (const id of ids) {
      if (!definitions.has(id)) {
        definitions.set(id, {
          id,
          label: id,
          description: `${appName} app privilege.`,
          scope: "tenant",
        });
      }
    }
  }

  return [...definitions.values()].sort((left, right) => {
    if (left.scope !== right.scope) {
      return left.scope.localeCompare(right.scope);
    }
    return left.id.localeCompare(right.id);
  });
}

async function getPrivilegeDefinition(id: string) {
  return (await listPrivilegeDefinitions()).find((item) => item.id === id);
}

async function validatePlatformGrants(grants: PrivilegeGrant[]) {
  const seen = new Set<string>();

  for (const grant of grants) {
    const definition = await getPrivilegeDefinition(grant.privilege);
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

async function validateTenantGrants(grants: PrivilegeGrant[], tenantId: string) {
  const tenantPrivileges = new Set(
    (await listPrivilegeDefinitions())
      .filter((item) => item.scope === "tenant")
      .map((item) => item.id),
  );
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
    return reply.send({ items: await listPrivilegeDefinitions() });
  });

  app.get("/identity/users", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformPrivilege(request, "platform.users.read");

    const pool = getPool();
    const users = await pool.query(
      "select id, email, display_name, nickname, status, created_at, updated_at from core.users order by email asc",
    );
    const privileges = await pool.query(
      "select user_id, privilege, tenant_id from core.user_privileges order by privilege asc",
    );
    const grantsByUser = new Map<string, PrivilegeGrant[]>();

    for (const row of privileges.rows) {
      const userId = String(row["user_id"]);
      grantsByUser.set(userId, [...(grantsByUser.get(userId) ?? []), mapGrant(row)]);
    }

    const memberships = await loadMemberships();
    const membershipsByUser = new Map<string, unknown[]>();
    for (const membership of memberships)
      membershipsByUser.set(membership.user_id, [
        ...(membershipsByUser.get(membership.user_id) ?? []),
        membership,
      ]);
    return reply.send({
      items: users.rows.map((row) =>
        mapUser(
          { ...row, memberships: membershipsByUser.get(String(row["id"])) ?? [] },
          grantsByUser.get(String(row["id"])) ?? [],
        ),
      ),
    });
  });

  app.post("/identity/users", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformPrivilege(request, "platform.users.manage");
    const parsed = createUserSchema.parse(request.body);

    const pool = getPool();
    const client = await pool.connect();
    let row: Record<string, unknown>;
    try {
      await client.query("begin");
      const duplicateTenants = new Set(
        parsed.memberships.map((membership) => membership.tenant_id),
      );
      if (duplicateTenants.size !== parsed.memberships.length)
        throw new HttpError(400, "Each tenant can only be selected once");
      const userId = await generateDatabaseIdentifier(
        client,
        "users",
        "usr",
        userSlugSource({
          nickname: parsed.nickname,
          displayName: parsed.display_name,
          email: parsed.email,
        }),
      );
      const result = await client.query(
        `insert into core.users (id, email, display_name, nickname, password_hash, status)
         values ($1, $2, $3, $4, $5, $6)
         returning id, email, display_name, nickname, status, created_at, updated_at`,
        [
          userId,
          parsed.email.toLowerCase(),
          parsed.display_name ?? null,
          parsed.nickname ?? null,
          hashPassword(parsed.password),
          parsed.status,
        ],
      );
      for (const membership of parsed.memberships) {
        await createTenantMembership(client, {
          tenantId: membership.tenant_id,
          userId,
          roleIds: membership.role_ids,
          roleKeys: membership.role_keys,
        });
      }
      row = result.rows[0] as Record<string, unknown>;
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
      action: "identity.user.create",
      objectRef: String(row["id"]),
      metadata: {
        email: parsed.email,
        status: parsed.status,
        generated_id: row["id"],
        memberships: parsed.memberships,
      },
    });

    const memberships = await loadMemberships({ userId: String(row["id"]) });
    return reply.status(201).send(mapUser({ ...row, memberships }));
  });

  app.patch("/identity/users/:userId", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformPrivilege(request, "platform.users.manage");
    const params = z.object({ userId: userIdSchema }).parse(request.params);
    const parsed = patchUserSchema.parse(request.body);

    const pool = getPool();
    const result = await pool.query(
      `update core.users
          set email = coalesce($2, email),
              display_name = case when $3 then $4 else display_name end,
              nickname = case when $5 then $6 else nickname end,
              status = coalesce($7, status),
              updated_at = now()
        where id = $1
        returning id, email, display_name, nickname, status, created_at, updated_at`,
      [
        params.userId,
        parsed.email ?? null,
        Object.prototype.hasOwnProperty.call(parsed, "display_name"),
        parsed.display_name ?? null,
        Object.prototype.hasOwnProperty.call(parsed, "nickname"),
        parsed.nickname ?? null,
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
    requirePlatformPrivilege(request, "platform.users.manage");
    const params = z.object({ userId: userIdSchema }).parse(request.params);
    const parsed = resetPasswordSchema.parse(request.body);

    const pool = getPool();
    const result = await pool.query(
      "update core.users set password_hash = $2, updated_at = now() where id = $1",
      [params.userId, hashPassword(parsed.password)],
    );
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
    requirePlatformPrivilege(request, "platform.users.manage");
    const params = z.object({ userId: userIdSchema }).parse(request.params);
    const parsed = replacePrivilegesSchema.parse(request.body);
    const grants = parsed.grants.map((grant) => ({
      privilege: grant.privilege,
      tenant_id: grant.tenant_id ?? null,
    }));
    await validatePlatformGrants(grants);

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
        await client.query(
          "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3)",
          [params.userId, grant.tenant_id, grant.privilege],
        );
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
    requirePlatformPrivilege(request, "platform.tenants.read");

    const pool = getPool();
    const result = await pool.query(
      "select id, name, primary_domain, status, created_at, updated_at from core.tenants order by name asc",
    );
    return reply.send({ items: result.rows.map(mapTenant) });
  });

  app.post("/identity/tenants", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformPrivilege(request, "platform.tenants.manage");
    const parsed = createTenantSchema.parse(request.body);

    const pool = getPool();
    const client = await pool.connect();
    let row: Record<string, unknown>;
    try {
      await client.query("begin");
      const tenantId = await generateDatabaseIdentifier(client, "tenants", "tnt", parsed.name);
      const result = await client.query(
        `insert into core.tenants (id, name, primary_domain, status)
         values ($1, $2, $3, $4)
         returning id, name, primary_domain, status, created_at, updated_at`,
        [tenantId, parsed.name, parsed.primary_domain?.toLowerCase() ?? null, parsed.status],
      );
      await provisionSystemTenantRoles(client, tenantId);
      if (parsed.first_admin_user_id) {
        await createTenantMembership(client, {
          tenantId,
          userId: parsed.first_admin_user_id,
          roleKeys: ["tenant_admin"],
        });
      }
      row = result.rows[0] as Record<string, unknown>;
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
      action: "identity.tenant.create",
      objectRef: String(row["id"]),
      metadata: {
        name: parsed.name,
        primary_domain: parsed.primary_domain ?? null,
        status: parsed.status,
        generated_id: row["id"],
        first_admin_user_id: parsed.first_admin_user_id ?? null,
      },
    });

    return reply.status(201).send(mapTenant(row));
  });

  app.patch("/identity/tenants/:tenantId", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformPrivilege(request, "platform.tenants.manage");
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

  app.get("/identity/roles", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformPrivilege(request, "platform.tenants.read");
    const query = z.object({ tenant_id: userIdSchema }).parse(request.query);
    return reply.send({ items: await loadRoles(query.tenant_id) });
  });

  app.get("/identity/tenant-memberships", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformPrivilege(request, "platform.users.read");
    const query = z
      .object({ user_id: userIdSchema.optional(), tenant_id: userIdSchema.optional() })
      .parse(request.query);
    return reply.send({
      items: await loadMemberships({ userId: query.user_id, tenantId: query.tenant_id }),
    });
  });

  app.post("/identity/tenant-memberships", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformPrivilege(request, "platform.users.manage");
    const parsed = createMembershipSchema.extend({ tenant_id: userIdSchema }).parse(request.body);
    const client = await getPool().connect();
    let membership: Record<string, unknown>;
    try {
      await client.query("begin");
      membership = await createTenantMembership(client, {
        tenantId: parsed.tenant_id,
        userId: parsed.user_id,
        status: parsed.status,
        roleIds: parsed.role_ids,
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await recordAudit({
      tenantId: parsed.tenant_id,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "tenant.membership.create",
      objectRef: String(membership["id"]),
      metadata: { after: membership, role_ids: parsed.role_ids },
    });
    return reply
      .status(201)
      .send((await loadMemberships({ userId: parsed.user_id, tenantId: parsed.tenant_id }))[0]);
  });

  app.get("/tenant/memberships", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.members.read");
    return reply.send({
      items: await loadMemberships({ tenantId: request.requestContext.tenant.tenantId }),
    });
  });

  app.post("/tenant/memberships", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.members.manage");
    const parsed = createMembershipSchema.omit({ tenant_id: true }).parse(request.body);
    const tenantId = request.requestContext.tenant.tenantId;
    const client = await getPool().connect();
    let membership: Record<string, unknown>;
    try {
      await client.query("begin");
      membership = await createTenantMembership(client, {
        tenantId,
        userId: parsed.user_id,
        status: parsed.status,
        roleIds: parsed.role_ids,
      });
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
      action: "tenant.membership.create",
      objectRef: String(membership["id"]),
      metadata: { after: membership, role_ids: parsed.role_ids },
    });
    return reply.status(201).send((await loadMemberships({ userId: parsed.user_id, tenantId }))[0]);
  });

  app.patch("/tenant/memberships/:membershipId", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.members.manage");
    const params = membershipParamsSchema.parse(request.params);
    const parsed = patchMembershipSchema.parse(request.body);
    const tenantId = request.requestContext.tenant.tenantId;
    const before = await getPool().query(
      "select * from core.tenant_memberships where id=$1 and tenant_id=$2",
      [params.membershipId, tenantId],
    );
    if (!before.rowCount) throw new NotFoundError("Membership not found");
    const result = await getPool().query(
      `update core.tenant_memberships set status=$3, version=version+1, updated_at=now()
        where id=$1 and tenant_id=$2 and version=$4 returning *`,
      [params.membershipId, tenantId, parsed.status, parsed.version],
    );
    if (!result.rowCount)
      throw new HttpError(409, "Membership was changed by another administrator");
    await recordAudit({
      tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "tenant.membership.status.update",
      objectRef: params.membershipId,
      metadata: { before: before.rows[0], after: result.rows[0] },
    });
    return reply.send(
      (await loadMemberships({ userId: String(result.rows[0]["user_id"]), tenantId }))[0],
    );
  });

  app.delete("/tenant/memberships/:membershipId", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.members.manage");
    const params = membershipParamsSchema.parse(request.params);
    const tenantId = request.requestContext.tenant.tenantId;
    const result = await getPool().query(
      "delete from core.tenant_memberships where id=$1 and tenant_id=$2 returning *",
      [params.membershipId, tenantId],
    );
    if (!result.rowCount) throw new NotFoundError("Membership not found");
    await recordAudit({
      tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "tenant.membership.delete",
      objectRef: params.membershipId,
      metadata: { before: result.rows[0] },
    });
    return reply.status(204).send();
  });

  app.post("/tenant/memberships/:membershipId/roles/:roleId", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.members.manage");
    const params = membershipRoleParamsSchema.parse(request.params);
    const tenantId = request.requestContext.tenant.tenantId;
    const result = await getPool().query(
      `insert into core.tenant_member_roles (tenant_membership_id, role_id)
       select tm.id, tr.id from core.tenant_memberships tm join core.tenant_roles tr on tr.tenant_id=tm.tenant_id
        where tm.id=$1 and tr.id=$2 and tm.tenant_id=$3 on conflict do nothing returning *`,
      [params.membershipId, params.roleId, tenantId],
    );
    if (!result.rowCount)
      throw new HttpError(409, "Role is already assigned or does not belong to this tenant");
    await recordAudit({
      tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "tenant.membership.role.assign",
      objectRef: params.membershipId,
      metadata: { role_id: params.roleId },
    });
    return reply.status(204).send();
  });

  app.delete("/tenant/memberships/:membershipId/roles/:roleId", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.members.manage");
    const params = membershipRoleParamsSchema.parse(request.params);
    const tenantId = request.requestContext.tenant.tenantId;
    const role = await getPool().query(
      "select key from core.tenant_roles where id=$1 and tenant_id=$2",
      [params.roleId, tenantId],
    );
    if (!role.rowCount) throw new NotFoundError("Role not found");
    if (role.rows[0]["key"] === "tenant_member")
      throw new HttpError(409, "The base tenant_member role cannot be removed");
    const result = await getPool().query(
      `delete from core.tenant_member_roles tmr using core.tenant_memberships tm
        where tmr.tenant_membership_id=tm.id and tmr.tenant_membership_id=$1 and tmr.role_id=$2 and tm.tenant_id=$3 returning tmr.*`,
      [params.membershipId, params.roleId, tenantId],
    );
    if (!result.rowCount) throw new NotFoundError("Role assignment not found");
    await recordAudit({
      tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "tenant.membership.role.remove",
      objectRef: params.membershipId,
      metadata: { role_id: params.roleId },
    });
    return reply.status(204).send();
  });

  app.get("/tenant/roles", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.roles.read");
    return reply.send({ items: await loadRoles(request.requestContext.tenant.tenantId) });
  });

  app.post("/tenant/roles", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.roles.manage");
    const parsed = createRoleSchema.parse(request.body);
    await validateTenantGrants(
      parsed.privileges.map((privilege) => ({
        privilege,
        tenant_id: request.requestContext.tenant.tenantId,
      })),
      request.requestContext.tenant.tenantId,
    );
    const tenantId = request.requestContext.tenant.tenantId;
    const client = await getPool().connect();
    let roleId = "";
    try {
      await client.query("begin");
      const result = await client.query(
        `insert into core.tenant_roles (tenant_id,key,name,description) values($1,$2,$3,$4) returning id`,
        [tenantId, parsed.key, parsed.name, parsed.description],
      );
      roleId = String(result.rows[0]["id"]);
      for (const privilege of parsed.privileges)
        await client.query(
          "insert into core.role_privileges(role_id,privilege_key) values($1,$2)",
          [roleId, privilege],
        );
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
      action: "tenant.role.create",
      objectRef: roleId,
      metadata: { after: parsed },
    });
    return reply.status(201).send((await loadRoles(tenantId)).find((role) => role.id === roleId));
  });

  app.patch("/tenant/roles/:roleId", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.roles.manage");
    const params = roleParamsSchema.parse(request.params);
    const parsed = patchRoleSchema.parse(request.body);
    const tenantId = request.requestContext.tenant.tenantId;
    const result = await getPool().query(
      `update core.tenant_roles set name=coalesce($3,name), description=coalesce($4,description), version=version+1, updated_at=now()
        where id=$1 and tenant_id=$2 and version=$5 and not is_system returning *`,
      [params.roleId, tenantId, parsed.name ?? null, parsed.description ?? null, parsed.version],
    );
    if (!result.rowCount)
      throw new HttpError(
        409,
        "Role is system-protected, missing, or was changed by another administrator",
      );
    await recordAudit({
      tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "tenant.role.update",
      objectRef: params.roleId,
      metadata: { after: result.rows[0] },
    });
    return reply.send((await loadRoles(tenantId)).find((role) => role.id === params.roleId));
  });

  app.delete("/tenant/roles/:roleId", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.roles.manage");
    const params = roleParamsSchema.parse(request.params);
    const tenantId = request.requestContext.tenant.tenantId;
    const result = await getPool().query(
      `delete from core.tenant_roles tr where tr.id=$1 and tr.tenant_id=$2 and not tr.is_system
        and not exists(select 1 from core.tenant_member_roles where role_id=tr.id) returning tr.*`,
      [params.roleId, tenantId],
    );
    if (!result.rowCount) throw new HttpError(409, "System or assigned roles cannot be deleted");
    await recordAudit({
      tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "tenant.role.delete",
      objectRef: params.roleId,
      metadata: { before: result.rows[0] },
    });
    return reply.status(204).send();
  });

  app.post("/tenant/roles/:roleId/privileges/:privilegeKey", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.privileges.manage");
    const params = rolePrivilegeParamsSchema.parse(request.params);
    const tenantId = request.requestContext.tenant.tenantId;
    await validateTenantGrants([{ privilege: params.privilegeKey, tenant_id: tenantId }], tenantId);
    const result = await getPool().query(
      `insert into core.role_privileges(role_id,privilege_key)
       select id,$2 from core.tenant_roles where id=$1 and tenant_id=$3 and not is_system
       on conflict do nothing returning *`,
      [params.roleId, params.privilegeKey, tenantId],
    );
    if (!result.rowCount)
      throw new HttpError(409, "Privilege is already assigned or the role is system-protected");
    await recordAudit({
      tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "tenant.role.privilege.assign",
      objectRef: params.roleId,
      metadata: { privilege: params.privilegeKey },
    });
    return reply.status(204).send();
  });

  app.delete("/tenant/roles/:roleId/privileges/:privilegeKey", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.privileges.manage");
    const params = rolePrivilegeParamsSchema.parse(request.params);
    const tenantId = request.requestContext.tenant.tenantId;
    const result = await getPool().query(
      `delete from core.role_privileges rp using core.tenant_roles tr
        where rp.role_id=tr.id and tr.id=$1 and tr.tenant_id=$2 and not tr.is_system and rp.privilege_key=$3 returning rp.*`,
      [params.roleId, tenantId, params.privilegeKey],
    );
    if (!result.rowCount)
      throw new HttpError(409, "Privilege assignment is missing or the role is system-protected");
    await recordAudit({
      tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "tenant.role.privilege.remove",
      objectRef: params.roleId,
      metadata: { privilege: params.privilegeKey },
    });
    return reply.status(204).send();
  });

  app.get("/tenant/user-directory", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.members.manage");
    const query = z.object({ search: z.string().trim().min(2).max(160) }).parse(request.query);
    const search = `%${query.search.toLowerCase()}%`;
    const result = await getPool().query(
      `select u.id,u.email,u.display_name,u.nickname,u.status,u.created_at,u.updated_at
         from core.users u
        where u.status='active' and not exists(
          select 1 from core.tenant_memberships tm where tm.user_id=u.id and tm.tenant_id=$1
        ) and (lower(u.id) like $2 or lower(u.email) like $2 or lower(coalesce(u.display_name,'')) like $2 or lower(coalesce(u.nickname,'')) like $2)
        order by coalesce(u.display_name,u.email) limit 20`,
      [request.requestContext.tenant.tenantId, search],
    );
    return reply.send({ items: result.rows.map((row) => mapUser(row)) });
  });

  app.post("/tenant/users", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.members.manage");
    const parsed = createUserSchema
      .omit({ memberships: true })
      .extend({ role_ids: z.array(z.string().uuid()).max(20).default([]) })
      .parse(request.body);
    const tenantId = request.requestContext.tenant.tenantId;
    const client = await getPool().connect();
    let row: Record<string, unknown>;
    try {
      await client.query("begin");
      const userId = await generateDatabaseIdentifier(
        client,
        "users",
        "usr",
        userSlugSource({
          nickname: parsed.nickname,
          displayName: parsed.display_name,
          email: parsed.email,
        }),
      );
      const result = await client.query(
        `insert into core.users(id,email,display_name,nickname,password_hash,status) values($1,$2,$3,$4,$5,$6)
         returning id,email,display_name,nickname,status,created_at,updated_at`,
        [
          userId,
          parsed.email.toLowerCase(),
          parsed.display_name ?? null,
          parsed.nickname ?? null,
          hashPassword(parsed.password),
          parsed.status,
        ],
      );
      await createTenantMembership(client, { tenantId, userId, roleIds: parsed.role_ids });
      row = result.rows[0] as Record<string, unknown>;
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
      action: "tenant.user.create",
      objectRef: String(row["id"]),
      metadata: { after: row, role_ids: parsed.role_ids },
    });
    return reply
      .status(201)
      .send(
        mapUser({
          ...row,
          memberships: await loadMemberships({ userId: String(row["id"]), tenantId }),
        }),
      );
  });

  app.get("/tenant/users", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.members.read");

    const pool = getPool();
    const result = await pool.query(
      `select u.id, u.email, u.display_name, u.nickname, u.status, u.created_at, u.updated_at, up.privilege, up.tenant_id
         from core.tenant_memberships tm
         join core.users u on u.id=tm.user_id
         left join core.user_privileges up on up.user_id = u.id and up.tenant_id=tm.tenant_id
        where tm.tenant_id = $1
        order by u.email asc, up.privilege asc`,
      [request.requestContext.tenant.tenantId],
    );

    const users = new Map<string, { row: Record<string, unknown>; grants: PrivilegeGrant[] }>();
    for (const row of result.rows) {
      const userId = String(row["id"]);
      const current = users.get(userId) ?? { row, grants: [] as PrivilegeGrant[] };
      if (row["privilege"]) current.grants.push(mapGrant(row));
      users.set(userId, current);
    }
    const memberships = await loadMemberships({ tenantId: request.requestContext.tenant.tenantId });
    const byUser = new Map(memberships.map((membership) => [membership.user_id, membership]));
    return reply.send({
      items: [...users.values()].map((item) =>
        mapUser(
          { ...item.row, memberships: [byUser.get(String(item.row["id"]))].filter(Boolean) },
          item.grants,
        ),
      ),
    });
  });

  app.put("/tenant/users/:userId/privileges", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireTenantPrivilege(request, "tenant.privileges.manage");
    const params = z.object({ userId: userIdSchema }).parse(request.params);
    const parsed = replacePrivilegesSchema.parse(request.body);
    const tenantId = request.requestContext.tenant.tenantId;
    const grants = parsed.grants.map((grant) => ({
      privilege: grant.privilege,
      tenant_id: tenantId,
    }));
    await validateTenantGrants(grants, tenantId);
    await assertUserExists(params.userId);

    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query("delete from core.user_privileges where user_id = $1 and tenant_id = $2", [
        params.userId,
        tenantId,
      ]);
      for (const grant of grants) {
        await client.query(
          "insert into core.user_privileges (user_id, tenant_id, privilege) values ($1, $2, $3)",
          [params.userId, tenantId, grant.privilege],
        );
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
