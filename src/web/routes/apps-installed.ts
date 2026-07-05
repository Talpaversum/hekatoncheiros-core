import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { installFetchedApp } from "../../apps/app-installer.js";
import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { fetchManifest } from "../../apps/manifest-fetcher.js";
import { recordAudit } from "../../audit/audit-service.js";
import { getPool } from "../../db/pool.js";
import {
  clearSelectedTenantLicense,
  getSelectedTenantLicense,
  hasAnyTenantLicense,
} from "../../licensing/license-service.js";
import { getTrustedOriginsStore } from "../../platform/trusted-origins-store.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const fetchManifestSchema = z.object({
  base_url: z.string().url(),
});

const installSchema = z.object({
  base_url: z.string().url(),
  expected_manifest_hash: z.string().trim().regex(/^[a-f0-9]{64}$/i),
});

export async function registerInstalledAppRoutes(app: FastifyInstance) {
  const isTrustedOrigin = async (origin: string) => {
    const enabledOrigins = await getTrustedOriginsStore().listEnabledOrigins();
    return enabledOrigins.has(origin);
  };

  app.get("/apps/installed", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!hasPrivilege(request.requestContext.privileges, "platform.apps.manage")) {
      throw new ForbiddenError();
    }
    const store = getAppInstallationStore();
    const apps = await store.listInstalledApps();
    const tenantId = request.requestContext.tenant.tenantId;

    const items = await Promise.all(
      apps.map(async (installedApp) => {
        const [selectedLicense, anyLicense] = await Promise.all([
          getSelectedTenantLicense(tenantId, installedApp.app_id),
          hasAnyTenantLicense(tenantId, installedApp.app_id),
        ]);

        return {
          ...installedApp,
          resolved_entitlement: selectedLicense
            ? {
                entitlement_id: selectedLicense.jti,
                tenant_id: selectedLicense.tenant_id,
                app_id: selectedLicense.app_id,
                source: "LICENSE",
                tier: "licensed",
                valid_from: selectedLicense.valid_from,
                valid_to: selectedLicense.valid_to,
                limits: {},
              }
            : null,
          has_any_entitlement: anyLicense,
        };
      }),
    );

    return reply.send({
      items,
    });
  });

  app.post("/apps/installed", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!hasPrivilege(request.requestContext.privileges, "platform.apps.manage")) {
      throw new ForbiddenError();
    }

    const parsed = installSchema.parse(request.body);
    let fetched: Awaited<ReturnType<typeof fetchManifest>>;
    try {
      fetched = await fetchManifest(parsed.base_url, { isTrustedOrigin });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }

    if (fetched.manifestHash !== parsed.expected_manifest_hash) {
      return reply.code(409).send({ message: "manifest changed, refetch required" });
    }

    const tenantId = request.requestContext.tenant.tenantId;
    try {
      const result = await installFetchedApp({
        fetched,
        config,
        tenantId,
        actorUserId: request.requestContext.actor.userId,
        effectiveUserId: request.requestContext.actor.effectiveUserId,
      });
      return reply.code(201).send(result);
    } catch (error) {
      const message = (error as Error).message;
      if (message === "slug already in use") {
        return reply.code(409).send({ message });
      }
      return reply.code(400).send({ message });
    }
  });

  app.post("/apps/installed/fetch-manifest", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!hasPrivilege(request.requestContext.privileges, "platform.apps.manage")) {
      throw new ForbiddenError();
    }

    const parsed = fetchManifestSchema.parse(request.body);
    let fetched: Awaited<ReturnType<typeof fetchManifest>>;
    try {
      fetched = await fetchManifest(parsed.base_url, { isTrustedOrigin });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }

    const manifest = fetched.manifest;
    const appId = (manifest["app_id"] as string | undefined) ?? "";
    const integration = manifest["integration"] as { slug?: string } | undefined;

    return reply.send({
      normalized_base_url: fetched.normalizedBaseUrl,
      fetched_from_url: fetched.fetchedFromUrl,
      fetched_at: fetched.fetchedAt,
      manifest,
      manifest_hash: fetched.manifestHash,
      manifest_version: fetched.manifestVersion,
      app_id: appId,
      app_version: fetched.appVersion,
      slug: integration?.slug ?? null,
    });
  });

  app.post("/apps/installed/:app_id/refresh-artifact", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!hasPrivilege(request.requestContext.privileges, "platform.apps.manage")) {
      throw new ForbiddenError();
    }

    const appId = (request.params as { app_id: string }).app_id;
    const store = getAppInstallationStore();
    const installed = (await store.listInstalledApps()).find((item) => item.app_id === appId);
    if (!installed) {
      throw new NotFoundError("App not installed");
    }

    let fetched: Awaited<ReturnType<typeof fetchManifest>>;
    try {
      fetched = await fetchManifest(installed.base_url, { isTrustedOrigin });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }

    const manifestAppId = fetched.manifest["app_id"];
    if (manifestAppId !== appId) {
      return reply.code(409).send({ message: "refreshed manifest app_id does not match installed app" });
    }

    try {
      const result = await installFetchedApp({
        fetched,
        config,
        tenantId: request.requestContext.tenant.tenantId,
        actorUserId: request.requestContext.actor.userId,
        effectiveUserId: request.requestContext.actor.effectiveUserId,
      });
      return reply.send({
        ...result,
        refreshed_at: new Date().toISOString(),
      });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.delete("/apps/installed/:app_id", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!hasPrivilege(request.requestContext.privileges, "platform.apps.manage")) {
      throw new ForbiddenError();
    }

    const appId = (request.params as { app_id: string }).app_id;
    const store = getAppInstallationStore();
    const deleted = await store.uninstallApp(appId);
    const deletedCount = deleted ? 1 : 0;

    if (config.NODE_ENV !== "production") {
      try {
        const pool = getPool();
        const dbMeta = await pool.query(
          "select current_database() as current_database, inet_server_addr()::text as inet_server_addr",
        );
        const row = dbMeta.rows[0] as
          | { current_database?: string; inet_server_addr?: string | null }
          | undefined;

        app.log.info({
          action: "apps.uninstall.debug",
          app_id: appId,
          rowCount: deletedCount,
          current_database: row?.current_database ?? null,
          inet_server_addr: row?.inet_server_addr ?? null,
        });
      } catch (error) {
        app.log.warn({
          action: "apps.uninstall.debug.failed",
          app_id: appId,
          error: (error as Error).message,
        });
      }
    }

    if (!deleted) {
      throw new NotFoundError("App not installed");
    }

    await clearSelectedTenantLicense(request.requestContext.tenant.tenantId, appId);

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "platform.apps.uninstall",
      objectRef: appId,
      metadata: {
        app_id: appId,
      },
    });

    return reply.code(204).send();
  });
}
