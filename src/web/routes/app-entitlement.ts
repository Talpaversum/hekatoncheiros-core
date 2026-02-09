import type { FastifyInstance } from "fastify";

import { hasAllPrivileges } from "../../access/privileges.js";
import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { resolveEntitlement } from "../../licensing/entitlement-service.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

export async function registerAppEntitlementRoutes(app: FastifyInstance) {
  app.get("/apps/:slug/entitlement", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const slug = (request.params as { slug: string }).slug;
    const store = getAppInstallationStore();
    const appInfo = (await store.listInstalledApps()).find((item) => item.slug === slug) ?? null;
    if (!appInfo) {
      throw new NotFoundError("Unknown app");
    }

    if (!hasAllPrivileges(request.requestContext.privileges, appInfo.required_privileges)) {
      throw new ForbiddenError();
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const resolved = await resolveEntitlement(tenantId, appInfo.app_id, new Date());
    if (!resolved) {
      return reply.code(204).send();
    }

    return reply.send({
      tier: resolved.tier,
      valid_from: resolved.valid_from,
      valid_to: resolved.valid_to,
      limits: resolved.limits,
      source: resolved.source,
      entitlement_id: resolved.entitlement_id,
    });
  });
}
