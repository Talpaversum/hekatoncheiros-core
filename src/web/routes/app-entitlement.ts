import type { FastifyInstance } from "fastify";

import { hasAllPrivileges } from "../../access/privileges.js";
import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { getSelectedTenantLicense } from "../../licensing/license-service.js";
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
    const selected = await getSelectedTenantLicense(tenantId, appInfo.app_id);
    if (!selected || selected.status !== "active") {
      return reply.code(204).send();
    }

    return reply.send({
      tier: "licensed",
      valid_from: selected.valid_from,
      valid_to: selected.valid_to,
      limits: {},
      source: "LICENSE",
      entitlement_id: selected.jti,
    });
  });
}
