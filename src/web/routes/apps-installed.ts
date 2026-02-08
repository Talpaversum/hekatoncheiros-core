import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { issueInstallerToken } from "../../apps/installer-token.js";
import { validateManifest } from "../../apps/manifest-validator.js";
import { saveUiPluginArtifact } from "../../apps/ui-artifact-storage.js";
import { listActiveLicensedAppIdsForTenant } from "../../licensing/license-service.js";
import { ForbiddenError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const installSchema = z.object({
  app_id: z.string().min(1),
  base_url: z.string().url(),
  ui_url: z.string().url().optional(),
  required_privileges: z.array(z.string()).default([]),
  manifest: z.record(z.string(), z.unknown()),
});

export async function registerInstalledAppRoutes(app: FastifyInstance) {
  app.get("/apps/installed", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!request.requestContext.privileges.includes("platform.apps.manage")) {
      throw new ForbiddenError();
    }
    const store = getAppInstallationStore();
    const apps = await store.listInstalledApps();
    const tenantId = request.requestContext.tenant.tenantId;
    const licensedAppIds = new Set(await listActiveLicensedAppIdsForTenant(tenantId));
    return reply.send({
      items: apps.map((installedApp) => ({
        ...installedApp,
        licensed: licensedAppIds.has(installedApp.app_id),
      })),
    });
  });

  app.post("/apps/installed", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!request.requestContext.privileges.includes("platform.apps.manage")) {
      throw new ForbiddenError();
    }

    const parsed = installSchema.parse(request.body);
    await validateManifest(parsed.manifest);

    const manifestAppId = parsed.manifest["app_id"] as string | undefined;
    if (!manifestAppId || manifestAppId !== parsed.app_id) {
      return reply.code(400).send({ message: "manifest app_id mismatch" });
    }

    const integration = parsed.manifest["integration"] as {
      slug?: string;
      api?: { exposes?: { base_path?: string } };
      ui?: {
        artifact?: { url?: string; auth?: string };
        nav_entries?: Array<{ label: string; path: string; required_privileges?: string[] }>;
      };
    };
    const slug = integration?.slug;
    const basePath = integration?.api?.exposes?.base_path;
    const artifactPath = integration?.ui?.artifact?.url;
    const artifactAuth = integration?.ui?.artifact?.auth;
    if (!slug || !basePath || !artifactPath || !artifactAuth) {
      return reply.code(400).send({ message: "manifest integration.slug, integration.api.exposes.base_path, integration.ui.artifact.url and integration.ui.artifact.auth are required" });
    }

    if (artifactAuth !== "core-signed-token") {
      return reply.code(400).send({ message: "integration.ui.artifact.auth must be core-signed-token" });
    }

    const normalizedBasePath = `/apps/${slug}`;
    if (basePath !== normalizedBasePath) {
      return reply.code(400).send({ message: "integration.api.exposes.base_path must match slug" });
    }

    const artifactUrl = new URL(artifactPath, parsed.base_url);
    const unauthenticatedResponse = await fetch(artifactUrl);
    if (unauthenticatedResponse.status !== 401 && unauthenticatedResponse.status !== 403) {
      return reply.code(400).send({
        message: `artifact endpoint misconfigured: unauthenticated fetch must return 401/403, got ${unauthenticatedResponse.status}`,
      });
    }

    const installerToken = await issueInstallerToken({ appId: parsed.app_id, slug, config });
    const authenticatedResponse = await fetch(artifactUrl, {
      headers: {
        authorization: `Bearer ${installerToken}`,
      },
    });

    if (authenticatedResponse.status !== 200) {
      return reply.code(400).send({
        message: `artifact download failed with installer token: expected 200, got ${authenticatedResponse.status}`,
      });
    }

    const artifactContent = Buffer.from(await authenticatedResponse.arrayBuffer());
    if (artifactContent.length === 0) {
      return reply.code(400).send({ message: "artifact download failed: empty response body" });
    }

    const storedArtifact = await saveUiPluginArtifact({
      config,
      slug,
      content: artifactContent,
    });

    const coreHostedUiUrl = `/api/v1/apps/${slug}/ui/plugin.js`;

    const store = getAppInstallationStore();
    const existing = await store.listInstalledApps();
    const slugCollision = existing.find((app) => app.slug === slug && app.app_id !== parsed.app_id);
    if (slugCollision) {
      return reply.code(409).send({ message: "slug already in use" });
    }

    const rawNavEntries = (integration.ui?.nav_entries ?? []) as Array<{
      label: string;
      path: string;
      required_privileges?: string[];
    }>;
    const navEntries = rawNavEntries.map((entry) => {
      const normalizedPath = entry.path.replace(/^\/app\/[^/]+/, "");
      return {
        ...entry,
        path: `/app/${slug}${normalizedPath}`,
      };
    });

    await store.installApp({
      app_id: parsed.app_id,
      slug,
      base_url: parsed.base_url,
      ui_url: coreHostedUiUrl,
      ui_integrity: storedArtifact.sha256,
      required_privileges: parsed.required_privileges ?? [],
      manifest: {
        ...parsed.manifest,
        integration: {
          ...(parsed.manifest["integration"] as Record<string, unknown>),
          ui: {
            ...(integration?.ui as Record<string, unknown>),
            nav_entries: navEntries,
          },
        },
      },
    });

    return reply.code(201).send({ status: "installed", app_id: parsed.app_id });
  });

  app.delete("/apps/installed/:app_id", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!request.requestContext.privileges.includes("platform.apps.manage")) {
      throw new ForbiddenError();
    }

    const appId = (request.params as { app_id: string }).app_id;
    const store = getAppInstallationStore();
    await store.uninstallApp(appId);
    return reply.code(204).send();
  });
}
