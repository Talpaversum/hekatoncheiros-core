import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { recordAudit } from "../../audit/audit-service.js";
import { getPool } from "../../db/pool.js";
import { PLATFORM_LOCALES } from "../../localization/contract.js";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const patchAccountSchema = z.object({
  display_name: z.string().trim().max(160).optional().nullable(),
  email: z.string().trim().email().optional(),
  preferred_locale: z.enum(PLATFORM_LOCALES).optional(),
});

const passwordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(256),
});

const preferenceNamespaceSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,79}$/);
const preferenceSchema = z.object({ value: z.record(z.string(), z.unknown()).nullable() });

function hashPassword(password: string) {
  return createHash("sha256").update(password).digest("hex");
}

function mapUser(row: Record<string, unknown>) {
  return {
    id: String(row["id"]),
    email: String(row["email"]),
    display_name: (row["display_name"] as string | null) ?? null,
    status: String(row["status"]),
    preferred_locale: String(row["preferred_locale"] ?? "en"),
    created_at: new Date(String(row["created_at"])).toISOString(),
    updated_at: new Date(String(row["updated_at"] ?? row["created_at"])).toISOString(),
  };
}

export async function registerAccountRoutes(app: FastifyInstance) {
  app.get("/account/preferences/:namespace", async (request, reply) => {
    await requireUserAuth(request, app.config);
    const namespace = preferenceNamespaceSchema.parse((request.params as { namespace: string }).namespace);
    const result = await getPool().query("select value, updated_at from core.user_preferences where user_id = $1 and namespace = $2", [request.requestContext.actor.userId, namespace]);
    return reply.send(result.rows[0] ?? { value: null, updated_at: null });
  });

  app.put("/account/preferences/:namespace", async (request, reply) => {
    await requireUserAuth(request, app.config);
    const namespace = preferenceNamespaceSchema.parse((request.params as { namespace: string }).namespace);
    const parsed = preferenceSchema.parse(request.body);
    if (Buffer.byteLength(JSON.stringify(parsed.value), "utf8") > 128 * 1024) throw new ForbiddenError("Preference value is too large");
    const pool = getPool();
    if (parsed.value === null) {
      await pool.query("delete from core.user_preferences where user_id = $1 and namespace = $2", [request.requestContext.actor.userId, namespace]);
    } else {
      await pool.query(`insert into core.user_preferences (user_id, namespace, value) values ($1, $2, $3)
        on conflict (user_id, namespace) do update set value = excluded.value, updated_at = now()`, [request.requestContext.actor.userId, namespace, parsed.value]);
    }
    await recordAudit({ tenantId: request.requestContext.tenant.tenantId, actorUserId: request.requestContext.actor.userId, effectiveUserId: request.requestContext.actor.effectiveUserId, action: "account.preferences.updated", objectRef: namespace, metadata: { namespace, reset: parsed.value === null } });
    return reply.code(204).send();
  });

  app.get("/account", async (request, reply) => {
    await requireUserAuth(request, app.config);

    const pool = getPool();
    const result = await pool.query(
      "select id, email, display_name, status, preferred_locale, created_at, updated_at from core.users where id = $1",
      [request.requestContext.actor.userId],
    );

    if (!result.rowCount) {
      throw new NotFoundError("Account not found");
    }

    return reply.send(mapUser(result.rows[0]));
  });

  app.patch("/account", async (request, reply) => {
    await requireUserAuth(request, app.config);
    const parsed = patchAccountSchema.parse(request.body);

    const pool = getPool();
    if (parsed.email) {
      const duplicate = await pool.query("select id from core.users where lower(email) = lower($1) and id <> $2", [
        parsed.email,
        request.requestContext.actor.userId,
      ]);
      if ((duplicate.rowCount ?? 0) > 0) {
        throw new ForbiddenError("Email is already used by another account");
      }
    }

    const result = await pool.query(
      `update core.users
          set email = coalesce($2, email),
              display_name = case when $3 then $4 else display_name end,
              preferred_locale = coalesce($5, preferred_locale),
              updated_at = now()
        where id = $1
        returning id, email, display_name, status, preferred_locale, created_at, updated_at`,
      [
        request.requestContext.actor.userId,
        parsed.email ?? null,
        Object.prototype.hasOwnProperty.call(parsed, "display_name"),
        parsed.display_name ?? null,
        parsed.preferred_locale ?? null,
      ],
    );

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "account.update",
      objectRef: request.requestContext.actor.userId,
      metadata: {},
    });

    return reply.send(mapUser(result.rows[0]));
  });

  app.post("/account/password", async (request, reply) => {
    await requireUserAuth(request, app.config);
    const parsed = passwordSchema.parse(request.body);

    const pool = getPool();
    const existing = await pool.query("select password_hash from core.users where id = $1", [
      request.requestContext.actor.userId,
    ]);
    if (!existing.rowCount) {
      throw new NotFoundError("Account not found");
    }

    if (existing.rows[0].password_hash !== hashPassword(parsed.current_password)) {
      throw new UnauthorizedError("Current password is incorrect");
    }

    await pool.query("update core.users set password_hash = $2, updated_at = now() where id = $1", [
      request.requestContext.actor.userId,
      hashPassword(parsed.new_password),
    ]);

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "account.password.change",
      objectRef: request.requestContext.actor.userId,
      metadata: {},
    });

    return reply.code(204).send();
  });
}
