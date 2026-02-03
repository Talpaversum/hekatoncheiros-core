import type { FastifyInstance } from "fastify";

import { recordAudit } from "../../audit/audit-service.js";
import { ForbiddenError } from "../../shared/errors.js";
import { requireAppAuth } from "../plugins/auth-app.js";
import { requireUserAuth } from "../plugins/auth-user.js";

export async function registerAuditRoutes(app: FastifyInstance) {
  app.post("/audit/record", async (request, reply) => {
    const config = app.config;
    const authHeader = request.headers.authorization ?? "";
    let usedUserAuth = false;
    if (authHeader.startsWith("Bearer ")) {
      try {
        await requireAppAuth(request, config);
      } catch {
        await requireUserAuth(request, config);
        usedUserAuth = true;
      }
    } else {
      await requireUserAuth(request, config);
      usedUserAuth = true;
    }

    if (usedUserAuth && !request.requestContext.privileges.includes("core.audit.append")) {
      throw new ForbiddenError();
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const actor = request.requestContext.actor;
    const body = request.body as { action: string; object_ref: string; metadata?: Record<string, unknown> };
    await recordAudit({
      tenantId,
      actorUserId: actor.type === "user" ? actor.userId : null,
      effectiveUserId: actor.type === "user" ? actor.effectiveUserId : null,
      action: body.action,
      objectRef: body.object_ref,
      metadata: body.metadata ?? {},
    });
    return reply.code(204).send();
  });
}
