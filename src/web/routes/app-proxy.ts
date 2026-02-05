import type { FastifyInstance } from "fastify";

import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { ForbiddenError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

export async function registerAppProxyRoutes(app: FastifyInstance) {
  app.all("/apps/:app_id/*", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const appId = request.params.app_id as string;
    const store = getAppInstallationStore();
    const appInfo = await store.getApp(appId);
    if (!appInfo) {
      return reply.code(404).send({ message: "Unknown app" });
    }

    if (!appInfo.required_privileges.every((priv) => request.requestContext.privileges.includes(priv))) {
      throw new ForbiddenError();
    }

    const basePath = `/api/v1/apps/${appId}`;
    const forwardPath = request.url.replace(basePath, "");
    const url = new URL(appInfo.base_url.replace(/\/$/, "") + forwardPath);

    const payload =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : typeof request.body === "string"
          ? request.body
          : JSON.stringify(request.body ?? {});

    const response = await fetch(url, {
      method: request.method,
      headers: {
        "content-type": request.headers["content-type"] ?? "application/json",
        "x-tenant-id": request.requestContext.tenant.tenantId,
        "x-actor-id": request.requestContext.actor.userId,
        "x-actor-effective-id": request.requestContext.actor.effectiveUserId,
      },
      body: payload,
    });

    const text = await response.text();
    reply.code(response.status);
    response.headers.forEach((value, key) => reply.header(key, value));
    return reply.send(text);
  });
}
