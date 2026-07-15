import type { FastifyInstance } from "fastify";

import { disableAppForTenant, enableAppForTenant, registerApp } from "../../apps/app-registry-service.js";
import { validateManifest } from "../../apps/manifest-validator.js";
import { recordAudit } from "../../audit/audit-service.js";
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
    await recordAudit({ tenantId: request.requestContext.tenant.tenantId, actorUserId: request.requestContext.actor.userId, effectiveUserId: request.requestContext.actor.effectiveUserId, action: "app.registered", objectRef: result.app_id, metadata: { app_id: result.app_id, version: result.version } });
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
    await recordAudit({ tenantId, actorUserId: request.requestContext.actor.userId, effectiveUserId: request.requestContext.actor.effectiveUserId, action: "app.enabled", objectRef: appId, metadata: { app_id: appId, version: body.version } });
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
    await recordAudit({ tenantId, actorUserId: request.requestContext.actor.userId, effectiveUserId: request.requestContext.actor.effectiveUserId, action: "app.disabled", objectRef: appId, metadata: { app_id: appId } });
    return reply.code(204).send();
  });
}
