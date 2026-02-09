import type { FastifyInstance } from "fastify";

import {
  clearSelectedEntitlement,
  getSelectedEntitlementId,
  ingestOfflineToken,
  listEntitlements,
  setSelectedEntitlement,
} from "../../licensing/entitlement-service.js";
import { ForbiddenError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

export async function registerLicensingRoutes(app: FastifyInstance) {
  app.get("/licensing/entitlements", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.read")) {
      throw new ForbiddenError();
    }

    const query = (request.query ?? {}) as { app_id?: string };
    if (!query.app_id || query.app_id.trim().length === 0) {
      return reply.code(400).send({ message: "Missing app_id query parameter" });
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const appId = query.app_id;
    const [entitlements, selectedEntitlementId] = await Promise.all([
      listEntitlements(tenantId, appId),
      getSelectedEntitlementId(tenantId, appId),
    ]);

    return reply.send({
      app_id: appId,
      selected_entitlement_id: selectedEntitlementId,
      items: entitlements,
    });
  });

  app.post("/licensing/selection", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.manage_selection")) {
      throw new ForbiddenError();
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const body = request.body as { app_id: string; entitlement_id: string };

    if (!body?.app_id || !body?.entitlement_id) {
      return reply.code(400).send({ message: "app_id and entitlement_id are required" });
    }

    await setSelectedEntitlement(tenantId, body.app_id, body.entitlement_id);
    return reply.code(204).send();
  });

  app.post("/licensing/selection/clear", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.manage_selection")) {
      throw new ForbiddenError();
    }

    const body = request.body as { app_id: string };
    if (!body?.app_id) {
      return reply.code(400).send({ message: "app_id is required" });
    }

    const tenantId = request.requestContext.tenant.tenantId;
    await clearSelectedEntitlement(tenantId, body.app_id);
    return reply.code(204).send();
  });

  app.post("/licensing/offline", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.ingest_offline")) {
      throw new ForbiddenError();
    }

    const body = request.body as { token: string };
    if (!body?.token) {
      return reply.code(400).send({ message: "token is required" });
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const ingested = await ingestOfflineToken({ tenantId, token: body.token });
    return reply.send({
      status: "ingested",
      verification_result: ingested.verification_result,
      entitlement: ingested.entitlement,
    });
  });
}
