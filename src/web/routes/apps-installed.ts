import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { fetchManifest } from "../../apps/manifest-fetcher.js";
import { issueInstallerToken } from "../../apps/installer-token.js";
import { saveUiPluginArtifact } from "../../apps/ui-artifact-storage.js";
import { recordAudit } from "../../audit/audit-service.js";
import { hasAnyEntitlement, resolveEntitlement } from "../../licensing/entitlement-service.js";
import { ForbiddenError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const fetchManifestSchema = z.object({
  base_url: z.string().url(),
});

const installSchema = z.object({
  base_url: z.string().url(),
  expected_manifest_hash: z.string().trim().regex(/^[a-f0-9]{64}$/i),
});

export async function registerInstalledAppRoutes(app: FastifyInstance) {
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
        const [resolvedEntitlement, anyEntitlement] = await Promise.all([
          resolveEntitlement(tenantId, installedApp.app_id, new Date()),
          hasAnyEntitlement(tenantId, installedApp.app_id),
        ]);

        return {
          ...installedApp,
          resolved_entitlement: resolvedEntitlement,
          has_any_entitlement: anyEntitlement,
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
      fetched = await fetchManifest(parsed.base_url);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }

    if (fetched.manifestHash !== parsed.expected_manifest_hash) {
      return reply.code(409).send({ message: "manifest changed, refetch required" });
    }

    const manifest = fetched.manifest;
    const manifestAppId = manifest["app_id"];
    if (typeof manifestAppId !== "string" || manifestAppId.trim().length === 0) {
      return reply.code(400).send({ message: "manifest app_id missing" });
    }

    const appId = manifestAppId;

    const integration = manifest["integration"] as {
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

    const artifactUrl = new URL(artifactPath, fetched.normalizedBaseUrl);
    const unauthenticatedResponse = await fetch(artifactUrl);
    if (unauthenticatedResponse.status !== 401 && unauthenticatedResponse.status !== 403) {
      return reply.code(400).send({
        message: `artifact endpoint misconfigured: unauthenticated fetch must return 401/403, got ${unauthenticatedResponse.status}`,
      });
    }

    const installerToken = await issueInstallerToken({ appId, slug, config });
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
    const slugCollision = existing.find((app) => app.slug === slug && app.app_id !== appId);
    if (slugCollision) {
      return reply.code(409).send({ message: "slug already in use" });
    }

    const requiredPrivileges =
      ((manifest["privileges"] as { required?: unknown } | undefined)?.required as string[] | undefined) ?? [];

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
      app_id: appId,
      slug,
      base_url: fetched.normalizedBaseUrl,
      app_version: fetched.appVersion,
      manifest_version: fetched.manifestVersion,
      fetched_at: fetched.fetchedAt,
      ui_url: coreHostedUiUrl,
      ui_integrity: storedArtifact.sha256,
      required_privileges: requiredPrivileges,
      manifest: {
        ...manifest,
        integration: {
          ...(manifest["integration"] as Record<string, unknown>),
          ui: {
            ...(integration?.ui as Record<string, unknown>),
            nav_entries: navEntries,
          },
        },
      },
    });

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "platform.apps.install",
      objectRef: appId,
      metadata: {
        base_url: fetched.normalizedBaseUrl,
        slug,
        app_version: fetched.appVersion,
        manifest_version: fetched.manifestVersion,
      },
    });

    return reply.code(201).send({ status: "installed", app_id: appId });
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
      fetched = await fetchManifest(parsed.base_url);
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

  app.delete("/apps/installed/:app_id", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!hasPrivilege(request.requestContext.privileges, "platform.apps.manage")) {
      throw new ForbiddenError();
    }

    const appId = (request.params as { app_id: string }).app_id;
    const store = getAppInstallationStore();
    await store.uninstallApp(appId);

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
