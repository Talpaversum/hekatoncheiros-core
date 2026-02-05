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

    const store = getAppInstallationStore();
    await store.installApp({
      app_id: parsed.app_id,
      base_url: parsed.base_url,
      ui_url: parsed.ui_url,
      required_privileges: parsed.required_privileges ?? [],
      manifest: parsed.manifest,
    });

    return reply.code(201).send({ status: "installed", app_id: parsed.app_id });
  });

  app.delete("/apps/installed/:app_id", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!request.requestContext.privileges.includes("platform.apps.manage")) {
      throw new ForbiddenError();
    }

    const appId = request.params.app_id as string;
    const store = getAppInstallationStore();
    await store.uninstallApp(appId);
    return reply.code(204).send();
  });
}
