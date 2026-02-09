import type { FastifyInstance } from "fastify";

import { loadPrivilegesForUser } from "../../access/privilege-evaluator.js";
import { requireUserAuth } from "../plugins/auth-user.js";

export async function registerContextRoutes(app: FastifyInstance) {
  app.get("/context", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const tenantId = request.requestContext.tenant.tenantId;
    const actor = request.requestContext.actor;

    const privileges = await loadPrivilegesForUser(actor.userId, tenantId);
    request.requestContext.privileges = privileges;

    return reply.send({
      tenant: {
        id: tenantId,
        mode: request.requestContext.tenant.mode,
      },
      actor: {
        user_id: actor.userId,
        effective_user_id: actor.effectiveUserId,
        impersonating: actor.impersonating,
        delegation: actor.delegation,
      },
      privileges,
      licenses: {},
    });
  });
}
