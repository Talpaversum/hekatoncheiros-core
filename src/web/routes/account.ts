import { createHash } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { recordAudit } from "../../audit/audit-service.js";
import { getPool } from "../../db/pool.js";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const patchAccountSchema = z.object({
  display_name: z.string().trim().max(160).optional().nullable(),
  email: z.string().trim().email().optional(),
});

const passwordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8).max(256),
});

function hashPassword(password: string) {
  return createHash("sha256").update(password).digest("hex");
}

function mapUser(row: Record<string, unknown>) {
  return {
    id: String(row["id"]),
    email: String(row["email"]),
    display_name: (row["display_name"] as string | null) ?? null,
    status: String(row["status"]),
    created_at: new Date(String(row["created_at"])).toISOString(),
    updated_at: new Date(String(row["updated_at"] ?? row["created_at"])).toISOString(),
  };
}

export async function registerAccountRoutes(app: FastifyInstance) {
  app.get("/account", async (request, reply) => {
    await requireUserAuth(request, app.config);

    const pool = getPool();
    const result = await pool.query(
      "select id, email, display_name, status, created_at, updated_at from core.users where id = $1",
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
              updated_at = now()
        where id = $1
        returning id, email, display_name, status, created_at, updated_at`,
      [
        request.requestContext.actor.userId,
        parsed.email ?? null,
        Object.prototype.hasOwnProperty.call(parsed, "display_name"),
        parsed.display_name ?? null,
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
