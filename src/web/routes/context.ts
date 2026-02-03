import type { FastifyInstance } from "fastify";

import { loadPrivilegesForUser } from "../../access/privilege-evaluator.js";
import { getAppLicense } from "../../licensing/license-service.js";
import { requireUserAuth } from "../plugins/auth-user.js";

export async function registerContextRoutes(app: FastifyInstance) {
  app.get("/context", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const tenantId = request.requestContext.tenant.tenantId;
    const actor = request.requestContext.actor;

    const privileges = await loadPrivilegesForUser(actor.userId, tenantId);
    request.requestContext.privileges = privileges;

    const licenses: Record<string, unknown> = {};
    if (privileges.includes("core.licensing.read")) {
      try {
        const license = await getAppLicense(tenantId, "app_inventory");
        licenses[license.app_id] = license;
      } catch {
        // ignore for MVP
      }
    }

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
      licenses,
    });
  });
}
