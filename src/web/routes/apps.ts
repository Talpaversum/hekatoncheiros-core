import type { FastifyInstance } from "fastify";

import { disableAppForTenant, enableAppForTenant, registerApp } from "../../apps/app-registry-service.js";
import { validateManifest } from "../../apps/manifest-validator.js";
import { ForbiddenError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

export async function registerAppRoutes(app: FastifyInstance) {
  app.post("/apps/register", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.apps.register")) {
      throw new ForbiddenError();
    }

    const body = request.body as { manifest: Record<string, unknown> };
    await validateManifest(body.manifest);
    const result = await registerApp(body.manifest);
    return reply.send(result);
  });

  app.post("/tenants/apps/:app_id/enable", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.apps.enable")) {
      throw new ForbiddenError();
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const appId = (request.params as { app_id: string }).app_id;
    const body = request.body as { version: string; config?: Record<string, unknown> };
    const result = await enableAppForTenant({
      tenantId,
      appId,
      version: body.version,
      config: body.config ?? {},
    });
    return reply.send(result);
  });

  app.post("/tenants/apps/:app_id/disable", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.apps.disable")) {
      throw new ForbiddenError();
    }
    const tenantId = request.requestContext.tenant.tenantId;
    const appId = (request.params as { app_id: string }).app_id;
    await disableAppForTenant(tenantId, appId);
    return reply.code(204).send();
  });
}
