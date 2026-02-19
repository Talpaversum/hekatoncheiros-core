import type { FastifyInstance } from "fastify";

import {
  completeLicenseOAuth,
  getSelectedTenantLicense,
  importLicenseMaterial,
  listTenantLicenses,
  normalizeImportPayload,
  selectTenantLicense,
  startLicenseOAuth,
  validateLicenseMaterial,
  validateStoredLicense,
  clearSelectedTenantLicense,
} from "../../licensing/license-service.js";
import { getPlatformInstanceAudienceId } from "../../licensing/platform-instance-service.js";
import { ForbiddenError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

function assertTenantAccess(routeTenantId: string, requestTenantId: string) {
  if (routeTenantId !== requestTenantId) {
    throw new ForbiddenError("Tenant mismatch");
  }
}

export async function registerLicensingRoutes(app: FastifyInstance) {
  app.get("/platform/instance-id", async (_request, reply) => {
    const platformInstanceId = await getPlatformInstanceAudienceId();
    return reply.send({ platform_instance_id: platformInstanceId });
  });

  app.post("/tenants/:tenantId/licenses/validate", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.read")) {
      throw new ForbiddenError();
    }

    const tenantId = (request.params as { tenantId: string }).tenantId;
    assertTenantAccess(tenantId, request.requestContext.tenant.tenantId);

    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body["license_jti"] === "string" && body["license_jti"].trim()) {
      const validated = await validateStoredLicense(tenantId, body["license_jti"]);
      return reply.send(validated);
    }

    const normalized = normalizeImportPayload(body);
    const validated = await validateLicenseMaterial({
      tenantId,
      license_jws: normalized.license_jws,
      author_cert_jws: normalized.author_cert_jws,
    });
    return reply.send(validated);
  });

  app.post("/tenants/:tenantId/licenses/import", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.ingest_offline")) {
      throw new ForbiddenError();
    }

    const tenantId = (request.params as { tenantId: string }).tenantId;
    assertTenantAccess(tenantId, request.requestContext.tenant.tenantId);

    const body = (request.body ?? {}) as Record<string, unknown>;
    const normalized = normalizeImportPayload(body);
    const stored = await importLicenseMaterial({
      tenantId,
      license_jws: normalized.license_jws,
      author_cert_jws: normalized.author_cert_jws,
    });
    return reply.send({
      status: "accepted",
      item: stored,
    });
  });

  app.get("/tenants/:tenantId/licenses", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.read")) {
      throw new ForbiddenError();
    }

    const tenantId = (request.params as { tenantId: string }).tenantId;
    assertTenantAccess(tenantId, request.requestContext.tenant.tenantId);

    const query = (request.query ?? {}) as { app_id?: string };
    const appId = query.app_id?.trim();
    const [items, selection] = await Promise.all([
      listTenantLicenses(tenantId, appId && appId.length > 0 ? appId : undefined),
      appId && appId.length > 0 ? getSelectedTenantLicense(tenantId, appId) : Promise.resolve(null),
    ]);

    return reply.send({
      app_id: appId ?? null,
      selected_license_jti: selection?.jti ?? null,
      items,
    });
  });

  app.get("/tenants/:tenantId/licenses/selection", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.read")) {
      throw new ForbiddenError();
    }

    const tenantId = (request.params as { tenantId: string }).tenantId;
    assertTenantAccess(tenantId, request.requestContext.tenant.tenantId);

    const query = (request.query ?? {}) as { app_id?: string };
    if (!query.app_id) {
      return reply.code(400).send({ message: "app_id is required" });
    }

    const selected = await getSelectedTenantLicense(tenantId, query.app_id);
    return reply.send({
      app_id: query.app_id,
      selected_license_jti: selected?.jti ?? null,
      selected_license: selected,
    });
  });

  app.post("/tenants/:tenantId/licenses/select", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.manage_selection")) {
      throw new ForbiddenError();
    }

    const tenantId = (request.params as { tenantId: string }).tenantId;
    assertTenantAccess(tenantId, request.requestContext.tenant.tenantId);

    const body = request.body as { app_id: string; license_jti: string };

    if (!body?.app_id || !body?.license_jti) {
      return reply.code(400).send({ message: "app_id and license_jti are required" });
    }

    await selectTenantLicense(tenantId, body.app_id, body.license_jti);
    return reply.code(204).send();
  });

  app.post("/tenants/:tenantId/licenses/selection/clear", async (request, reply) => {
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

    const tenantId = (request.params as { tenantId: string }).tenantId;
    assertTenantAccess(tenantId, request.requestContext.tenant.tenantId);
    await clearSelectedTenantLicense(tenantId, body.app_id);
    return reply.code(204).send();
  });

  app.get("/tenants/:tenantId/licenses/oauth/start", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.ingest_offline")) {
      throw new ForbiddenError();
    }

    const tenantId = (request.params as { tenantId: string }).tenantId;
    assertTenantAccess(tenantId, request.requestContext.tenant.tenantId);

    const query = request.query as {
      issuer?: string;
      app_id?: string;
      license_mode?: "portable" | "instance_bound";
      auto_select?: string;
    };

    if (!query.issuer || !query.app_id || !query.license_mode) {
      return reply.code(400).send({ message: "issuer, app_id and license_mode are required" });
    }

    const started = await startLicenseOAuth({
      tenantId,
      issuerUrl: query.issuer,
      appId: query.app_id,
      licenseMode: query.license_mode,
      autoSelect: query.auto_select === "true",
    });

    return reply.send({
      status: "redirect",
      redirect_url: started.redirect_url,
      state: started.state,
    });
  });

  app.get("/tenants/:tenantId/licenses/oauth/callback", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const privileges = request.requestContext.privileges;
    if (!privileges.includes("core.licensing.ingest_offline")) {
      throw new ForbiddenError();
    }

    const tenantId = (request.params as { tenantId: string }).tenantId;
    assertTenantAccess(tenantId, request.requestContext.tenant.tenantId);

    const query = request.query as { code?: string; state?: string };
    if (!query.code || !query.state) {
      return reply.code(400).send({ message: "code and state are required" });
    }

    const completed = await completeLicenseOAuth({
      tenantId,
      code: query.code,
      state: query.state,
    });

    return reply.send({
      status: "imported",
      auto_selected: completed.auto_selected,
      item: completed.imported,
    });
  });

  // Legacy compatibility endpoints (entitlement naming)
  app.get("/licensing/entitlements", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!request.requestContext.privileges.includes("core.licensing.read")) {
      throw new ForbiddenError();
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const appId = ((request.query ?? {}) as { app_id?: string }).app_id;
    if (!appId) {
      return reply.code(400).send({ message: "Missing app_id query parameter" });
    }

    const [items, selected] = await Promise.all([
      listTenantLicenses(tenantId, appId),
      getSelectedTenantLicense(tenantId, appId),
    ]);

    return reply.send({
      app_id: appId,
      selected_entitlement_id: selected?.jti ?? null,
      items: items.map((item) => ({
        id: item.jti,
        source: "LICENSE",
        tier: "licensed",
        valid_from: item.valid_from,
        valid_to: item.valid_to,
        limits: {},
        status: item.status,
      })),
    });
  });

  app.post("/licensing/selection", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!request.requestContext.privileges.includes("core.licensing.manage_selection")) {
      throw new ForbiddenError();
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const body = request.body as { app_id: string; entitlement_id: string };
    if (!body?.app_id || !body?.entitlement_id) {
      return reply.code(400).send({ message: "app_id and entitlement_id are required" });
    }
    await selectTenantLicense(tenantId, body.app_id, body.entitlement_id);
    return reply.code(204).send();
  });

  app.post("/licensing/selection/clear", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!request.requestContext.privileges.includes("core.licensing.manage_selection")) {
      throw new ForbiddenError();
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const body = request.body as { app_id: string };
    if (!body?.app_id) {
      return reply.code(400).send({ message: "app_id is required" });
    }
    await clearSelectedTenantLicense(tenantId, body.app_id);
    return reply.code(204).send();
  });

  app.post("/licensing/offline", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!request.requestContext.privileges.includes("core.licensing.ingest_offline")) {
      throw new ForbiddenError();
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const body = (request.body ?? {}) as Record<string, unknown>;
    const normalized = normalizeImportPayload(body);
    const imported = await importLicenseMaterial({
      tenantId,
      license_jws: normalized.license_jws,
      author_cert_jws: normalized.author_cert_jws,
    });
    return reply.send({
      status: "ingested",
      verification_result: imported.status,
      entitlement: {
        id: imported.jti,
        app_id: imported.app_id,
      },
    });
  });
}
