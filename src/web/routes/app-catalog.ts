import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { getAppCatalogStore } from "../../apps/app-catalog-store.js";
import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { installFetchedApp } from "../../apps/app-installer.js";
import { fetchManifest } from "../../apps/manifest-fetcher.js";
import {
  getSelectedTenantLicense,
  hasAnyTenantLicense,
} from "../../licensing/license-service.js";
import { getTrustedOriginsStore } from "../../platform/trusted-origins-store.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const upsertFromManifestSchema = z.object({
  base_url: z.string().url(),
  summary: z.string().trim().max(500).optional().nullable(),
  trust_status: z.enum(["dev", "manual", "unverified"]).optional(),
});

const installFromCatalogSchema = z.object({
  mode: z.enum(["external", "stage_only", "compose"]).default("external"),
});

function requireAppCatalogManage(request: { requestContext: { privileges: string[] } }) {
  if (!hasPrivilege(request.requestContext.privileges, "platform.apps.manage")) {
    throw new ForbiddenError();
  }
}

function requireAppRuntimeManage(request: { requestContext: { privileges: string[] } }) {
  if (!hasPrivilege(request.requestContext.privileges, "platform.apps.runtime.manage")) {
    throw new ForbiddenError();
  }
}

function buildDeploymentPlan(entry: { app_id: string; slug: string; base_url: string; deployment: Record<string, unknown> }) {
  const type = typeof entry.deployment["type"] === "string" ? entry.deployment["type"] : "external";
  return {
    app_id: entry.app_id,
    mode: type,
    service_name: typeof entry.deployment["service_name"] === "string" ? entry.deployment["service_name"] : entry.slug,
    internal_base_url:
      typeof entry.deployment["internal_base_url"] === "string" ? entry.deployment["internal_base_url"] : entry.base_url,
    compose_project:
      typeof entry.deployment["compose_project"] === "string" ? entry.deployment["compose_project"] : "hekatoncheiros-core",
    compose_file: typeof entry.deployment["compose_file"] === "string" ? entry.deployment["compose_file"] : null,
    published_ports_allowed: false,
    host_mounts_allowed: false,
    requires_approval: true,
  };
}

export async function registerAppCatalogRoutes(app: FastifyInstance) {
  const isTrustedOrigin = async (origin: string) => {
    const enabledOrigins = await getTrustedOriginsStore().listEnabledOrigins();
    return enabledOrigins.has(origin);
  };

  app.get("/apps/catalog", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAppCatalogManage(request);

    const tenantId = request.requestContext.tenant.tenantId;
    const [entries, installedApps] = await Promise.all([
      getAppCatalogStore().listEntries(),
      getAppInstallationStore().listInstalledApps(),
    ]);
    const installedByAppId = new Map(installedApps.map((installed) => [installed.app_id, installed]));

    const items = await Promise.all(
      entries.map(async (entry) => {
        const installed = installedByAppId.get(entry.app_id) ?? null;
        const [selectedLicense, anyLicense] = await Promise.all([
          getSelectedTenantLicense(tenantId, entry.app_id),
          hasAnyTenantLicense(tenantId, entry.app_id),
        ]);

        return {
          ...entry,
          installed: installed
            ? {
                slug: installed.slug,
                app_version: installed.app_version ?? null,
                ui_url: installed.ui_url,
                enabled: installed.enabled !== false,
              }
            : null,
          license_state: {
            required: entry.license_required,
            has_any_license: anyLicense,
            selected_active_license: selectedLicense?.status === "active" ? selectedLicense.jti : null,
          },
          install_payload: {
            base_url: entry.base_url,
            expected_manifest_hash: entry.manifest_hash,
          },
        };
      }),
    );

    return reply.send({ items });
  });

  app.post("/apps/catalog/entries/from-manifest", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAppCatalogManage(request);

    const parsed = upsertFromManifestSchema.parse(request.body);
    let fetched: Awaited<ReturnType<typeof fetchManifest>>;
    try {
      fetched = await fetchManifest(parsed.base_url, { isTrustedOrigin });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }

    const entry = await getAppCatalogStore().upsertFromManifest({
      fetched,
      summary: parsed.summary ?? null,
      trustStatus: parsed.trust_status ?? "manual",
      createdBy: request.requestContext.actor.userId,
    });

    return reply.code(201).send(entry);
  });

  app.post("/apps/catalog/entries/:app_id/install", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAppCatalogManage(request);

    const parsed = installFromCatalogSchema.parse(request.body ?? {});
    const appId = (request.params as { app_id: string }).app_id;
    const entry = await getAppCatalogStore().getEntry(appId);
    if (!entry) {
      throw new NotFoundError("Catalog entry not found");
    }

    const deploymentPlan = buildDeploymentPlan(entry);

    if (parsed.mode === "stage_only") {
      return reply.code(202).send({
        status: "staged",
        app_id: entry.app_id,
        deployment_plan: deploymentPlan,
      });
    }

    if (parsed.mode === "compose") {
      requireAppRuntimeManage(request);
      return reply.code(501).send({
        message: "Core-managed compose runtime is not implemented yet",
        code: "runtime_not_available",
        deployment_plan: {
          ...deploymentPlan,
          mode: "compose",
        },
      });
    }

    let fetched: Awaited<ReturnType<typeof fetchManifest>>;
    try {
      fetched = await fetchManifest(entry.base_url, { isTrustedOrigin });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }

    if (fetched.manifestHash !== entry.manifest_hash) {
      return reply.code(409).send({ message: "manifest changed, refresh catalog entry before install" });
    }

    try {
      const result = await installFetchedApp({
        fetched,
        config: app.config,
        tenantId: request.requestContext.tenant.tenantId,
        actorUserId: request.requestContext.actor.userId,
        effectiveUserId: request.requestContext.actor.effectiveUserId,
      });
      return reply.code(201).send({
        ...result,
        install_mode: "external",
        deployment_plan: deploymentPlan,
      });
    } catch (error) {
      const message = (error as Error).message;
      if (message === "slug already in use") {
        return reply.code(409).send({ message });
      }
      return reply.code(400).send({ message });
    }
  });

  app.delete("/apps/catalog/entries/:app_id", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAppCatalogManage(request);

    const appId = (request.params as { app_id: string }).app_id;
    const deleted = await getAppCatalogStore().deleteEntry(appId);
    if (!deleted) {
      throw new NotFoundError("Catalog entry not found");
    }

    return reply.code(204).send();
  });
}
