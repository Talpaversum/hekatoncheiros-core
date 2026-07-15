import type { FastifyInstance } from "fastify";

import { hasAllPrivileges } from "../../access/privileges.js";
import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { getAppRuntimeHealth } from "../../apps/app-runtime-health.js";
import { recordAudit } from "../../audit/audit-service.js";
import { getAuditRequestMetadata } from "../../audit/request-metadata.js";
import { hasSelectedActiveLicense } from "../../licensing/license-service.js";
import { ForbiddenError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

function requiresLicense(app: { manifest?: { licensing?: { required?: boolean } } }): boolean {
  return app.manifest?.licensing?.required === true;
}

export async function registerAppProxyRoutes(app: FastifyInstance) {
  app.all("/apps/:slug/*", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const slug = (request.params as { slug: string }).slug;
    const store = getAppInstallationStore();
    const appInfo = (await store.listInstalledApps()).find((item) => item.slug === slug) ?? null;
    if (!appInfo) {
      return reply.code(404).send({ message: "Unknown app" });
    }

    if (appInfo.enabled === false) {
      return reply.code(404).send({ message: "Unknown app" });
    }

    const runtime = getAppRuntimeHealth(appInfo.app_id);
    if (runtime.status !== "healthy" && runtime.status !== "degraded") {
      return reply.code(503).type("application/problem+json").send({ type: "https://hekatoncheiros.dev/problems/application-unavailable", title: "Application unavailable", status: 503, detail: "The requested application is currently unavailable.", appId: appInfo.app_id, runtimeStatus: runtime.status });
    }

    if (!hasAllPrivileges(request.requestContext.privileges, appInfo.required_privileges)) {
      await recordAudit({
        tenantId: request.requestContext.tenant.tenantId,
        actorUserId: request.requestContext.actor.userId,
        effectiveUserId: request.requestContext.actor.effectiveUserId,
        actorType: "user", applicationId: appInfo.app_id, sourceService: "core",
        eventType: appInfo.app_id === "com.talpaversum.inventory" ? "inventory.operation.denied" : "app.operation.denied",
        category: "authorization", action: "app.proxy.access", outcome: "denied", severity: "warning",
        scope: "tenant", visibility: "tenant_admin", resourceType: "application", resourceId: appInfo.app_id,
        message: "Application operation denied", metadata: { required_privileges: appInfo.required_privileges },
        ...getAuditRequestMetadata(request),
      });
      throw new ForbiddenError();
    }

    if (requiresLicense(appInfo)) {
      const hasLicense = await hasSelectedActiveLicense(request.requestContext.tenant.tenantId, appInfo.app_id);
      if (!hasLicense) {
        return reply.code(402).send({
          message: "License required",
          code: "license_required",
          app_id: appInfo.app_id,
        });
      }
    }

    const basePath = `/api/v1/apps/${slug}`;
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
        "x-correlation-id": getAuditRequestMetadata(request).correlationId,
      },
      body: payload,
    });

    const text = await response.text();
    reply.code(response.status);
    response.headers.forEach((value, key) => reply.header(key, value));
    return reply.send(text);
  });
}
