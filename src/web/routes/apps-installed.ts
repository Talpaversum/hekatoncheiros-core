import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { validateManifest } from "../../apps/manifest-validator.js";
import { ForbiddenError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const installSchema = z.object({
  app_id: z.string().min(1),
  base_url: z.string().url(),
  ui_url: z.string().url(),
  required_privileges: z.array(z.string()).default([]),
  manifest: z.record(z.unknown()),
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
    return reply.send({ items: apps });
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
      ui?: { nav_entries?: Array<{ label: string; path: string; required_privileges?: string[] }> };
    };
    const slug = integration?.slug;
    const basePath = integration?.api?.exposes?.base_path;
    if (!slug || !basePath) {
      return reply.code(400).send({ message: "manifest integration.slug and integration.api.exposes.base_path are required" });
    }

    const normalizedBasePath = `/apps/${slug}`;
    if (basePath !== normalizedBasePath) {
      return reply.code(400).send({ message: "integration.api.exposes.base_path must match slug" });
    }

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
      ui_url: parsed.ui_url,
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
