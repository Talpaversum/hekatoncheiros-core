import type { FastifyInstance } from "fastify";

import { activateOfflineLicense, getAppLicense } from "../../licensing/license-service.js";
import { ForbiddenError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

export async function registerLicensingRoutes(app: FastifyInstance) {
  app.get("/licensing/apps/:app_id", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.read")) {
      throw new ForbiddenError();
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const appId = request.params.app_id as string;
    const license = await getAppLicense(tenantId, appId);
    return reply.send(license);
  });

  app.post("/licensing/apps/:app_id/activate-offline", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.activate_offline")) {
      throw new ForbiddenError();
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const appId = request.params.app_id as string;
    const body = request.body as { license_blob: string; signature: string };
    const license = await activateOfflineLicense({
      tenantId,
      appId,
      licenseBlob: body.license_blob,
      signature: body.signature,
    });
    return reply.send(license);
  });
}
