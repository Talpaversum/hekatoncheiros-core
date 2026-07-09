import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { syncCatalogFeedSource } from "../../apps/app-catalog-feed-sync.js";
import { getAppCatalogStore, type AppCatalogEntry } from "../../apps/app-catalog-store.js";
import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { installFetchedApp } from "../../apps/app-installer.js";
import { validateAppRuntimeComposePolicy } from "../../apps/app-runtime-compose-policy.js";
import {
  stageAppRuntimePackage,
  unpackAppRuntimePackage,
} from "../../apps/app-runtime-package-stage.js";
import {
  assertComposeRuntimePlan,
  buildAppRuntimeDeploymentPlan,
} from "../../apps/app-runtime-plan.js";
import { fetchManifest } from "../../apps/manifest-fetcher.js";
import { getSelectedTenantLicense, hasAnyTenantLicense } from "../../licensing/license-service.js";
import { getPlatformInstanceId } from "../../licensing/platform-instance-service.js";
import { getTrustedOriginsStore } from "../../platform/trusted-origins-store.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const upsertFromManifestSchema = z.object({
  base_url: z.string().url(),
  summary: z.string().trim().max(500).optional().nullable(),
  trust_status: z.enum(["dev", "manual", "unverified"]).optional(),
});

const createFeedSourceSchema = z.object({
  name: z.string().trim().min(1).max(120),
  feed_url: z.string().url(),
  trust_mode: z.enum(["dev", "manual", "verified", "official"]).default("manual"),
});

const patchFeedSourceSchema = z.object({
  is_enabled: z.boolean(),
});

const installFromCatalogSchema = z.object({
  mode: z.enum(["external", "stage_only", "compose"]).default("external"),
  stage_package: z.boolean().default(false),
});

const publishCatalogEntrySchema = z.object({
  published: z.boolean(),
  note: z.string().trim().max(500).optional().nullable(),
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

function toFeedItem(entry: AppCatalogEntry) {
  return {
    app_id: entry.app_id,
    name: entry.app_name,
    version: entry.app_version,
    manifest_url: entry.manifest_url,
    manifest_sha256: entry.manifest_hash,
    author_id: entry.author_id,
    author_namespace: entry.namespace,
    summary: entry.summary,
    license_required: entry.license_required,
    license_issuer_url: entry.license_issuer_url,
    deployment: entry.deployment,
  };
}

export async function registerAppCatalogPublicRoutes(app: FastifyInstance) {
  app.get("/.well-known/hc/app-catalog.json", async (_request, reply) => {
    const entries = await getAppCatalogStore().listPublishedEntries();
    const items = entries.map((entry) => toFeedItem(entry));
    const instanceId = await getPlatformInstanceId();

    return reply.send({
      catalog_version: 1,
      publisher: {
        instance_id: instanceId,
        name: "Hekatoncheiros Core",
      },
      generated_at: new Date().toISOString(),
      items,
    });
  });
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
    const installedByAppId = new Map(
      installedApps.map((installed) => [installed.app_id, installed]),
    );

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
            selected_active_license:
              selectedLicense?.status === "active" ? selectedLicense.jti : null,
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

  app.get("/apps/catalog/sources", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAppCatalogManage(request);

    const items = await getAppCatalogStore().listSources();
    return reply.send({ items });
  });

  app.post("/apps/catalog/sources", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAppCatalogManage(request);

    const parsed = createFeedSourceSchema.parse(request.body);
    try {
      const source = await getAppCatalogStore().createFeedSource({
        name: parsed.name,
        feedUrl: parsed.feed_url,
        trustMode: parsed.trust_mode,
        createdBy: request.requestContext.actor.userId,
      });
      return reply.code(201).send(source);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.patch("/apps/catalog/sources/:id", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAppCatalogManage(request);

    const id = (request.params as { id: string }).id;
    const parsed = patchFeedSourceSchema.parse(request.body);
    const source = await getAppCatalogStore().setSourceEnabled(id, parsed.is_enabled);
    if (!source) {
      throw new NotFoundError("Catalog source not found");
    }

    return reply.send(source);
  });

  app.post("/apps/catalog/sources/:id/sync", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAppCatalogManage(request);

    const id = (request.params as { id: string }).id;
    const source = await getAppCatalogStore().getSource(id);
    if (!source) {
      throw new NotFoundError("Catalog source not found");
    }

    try {
      const result = await syncCatalogFeedSource({
        source,
        actorUserId: request.requestContext.actor.userId,
        isTrustedOrigin,
      });
      return reply.send(result);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
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

  app.post("/apps/catalog/entries/:app_id/refresh-from-installed", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAppCatalogManage(request);

    const appId = (request.params as { app_id: string }).app_id;
    const installed = await getAppInstallationStore().getApp(appId);
    if (!installed) {
      throw new NotFoundError("App not installed");
    }

    let fetched: Awaited<ReturnType<typeof fetchManifest>>;
    try {
      fetched = await fetchManifest(installed.base_url, { isTrustedOrigin });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }

    if (fetched.manifest["app_id"] !== appId) {
      return reply
        .code(409)
        .send({ message: "fetched manifest app_id does not match installed app" });
    }

    const existing = await getAppCatalogStore().getEntry(appId);
    const entry = await getAppCatalogStore().upsertFromManifest({
      fetched,
      sourceId: existing?.source_id ?? null,
      sourceType: existing?.source_type ?? "manual",
      trustStatus: existing?.trust_status ?? "manual",
      authorId: existing?.author_id ?? null,
      summary: existing?.summary ?? null,
      metadata: existing?.metadata ?? {},
      deployment: existing?.deployment ?? {
        type: "external",
        base_url: fetched.normalizedBaseUrl,
      },
      createdBy: request.requestContext.actor.userId,
    });

    return reply.send(entry);
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

    let deploymentPlan: ReturnType<typeof buildAppRuntimeDeploymentPlan>;
    try {
      deploymentPlan = buildAppRuntimeDeploymentPlan(entry);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }

    if (parsed.mode === "stage_only") {
      if (!parsed.stage_package) {
        return reply.code(202).send({
          status: "staged",
          app_id: entry.app_id,
          deployment_plan: deploymentPlan,
        });
      }

      requireAppRuntimeManage(request);
      try {
        assertComposeRuntimePlan(deploymentPlan);
        const packageStage = await stageAppRuntimePackage({
          config: app.config,
          plan: deploymentPlan,
          isTrustedOrigin,
        });
        const packageUnpack = await unpackAppRuntimePackage({
          config: app.config,
          plan: deploymentPlan,
          stage: packageStage,
        });
        const compose_policy = await validateAppRuntimeComposePolicy({
          plan: deploymentPlan,
          composeFilePath: packageUnpack.compose_file_path,
        });

        return reply.code(202).send({
          status: "staged",
          app_id: entry.app_id,
          deployment_plan: deploymentPlan,
          package_stage: packageStage,
          package_unpack: packageUnpack,
          compose_policy,
        });
      } catch (error) {
        return reply
          .code(400)
          .send({ message: (error as Error).message, deployment_plan: deploymentPlan });
      }
    }

    if (parsed.stage_package) {
      return reply.code(400).send({
        app_id: entry.app_id,
        message: "stage_package is only supported with mode=stage_only",
        deployment_plan: deploymentPlan,
      });
    }

    if (parsed.mode === "compose") {
      requireAppRuntimeManage(request);
      try {
        assertComposeRuntimePlan(deploymentPlan);
      } catch (error) {
        return reply
          .code(409)
          .send({ message: (error as Error).message, deployment_plan: deploymentPlan });
      }

      return reply.code(501).send({
        message: "Core-managed compose runtime is not implemented yet",
        code: "runtime_not_available",
        deployment_plan: deploymentPlan,
      });
    }

    let fetched: Awaited<ReturnType<typeof fetchManifest>>;
    try {
      fetched = await fetchManifest(entry.base_url, { isTrustedOrigin });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }

    if (fetched.manifestHash !== entry.manifest_hash) {
      return reply
        .code(409)
        .send({ message: "manifest changed, refresh catalog entry before install" });
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

  app.patch("/apps/catalog/entries/:app_id/publication", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAppCatalogManage(request);

    const parsed = publishCatalogEntrySchema.parse(request.body);
    const appId = (request.params as { app_id: string }).app_id;
    const existing = await getAppCatalogStore().getEntry(appId);
    if (!existing) {
      throw new NotFoundError("Catalog entry not found");
    }

    if (parsed.published) {
      const installedApps = await getAppInstallationStore().listInstalledApps();
      const installed = installedApps.find(
        (appEntry) => appEntry.app_id === appId && appEntry.enabled !== false,
      );
      if (!installed) {
        return reply
          .code(409)
          .send({ message: "Only installed and enabled apps can be published to the feed" });
      }
    }

    const entry = await getAppCatalogStore().setEntryPublished({
      appId,
      published: parsed.published,
      actorUserId: request.requestContext.actor.userId,
      note: parsed.note ?? null,
    });
    if (!entry) {
      throw new NotFoundError("Catalog entry not found");
    }

    return reply.send(entry);
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
