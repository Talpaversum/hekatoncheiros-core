import type { FastifyInstance } from "fastify";

import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { requireUserAuth } from "../plugins/auth-user.js";

export async function registerAppRegistryRoutes(app: FastifyInstance) {
  app.get("/apps/registry", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const store = getAppInstallationStore();
    const apps = await store.listInstalledApps();
    const items = apps
      .filter((app) => app.required_privileges.every((priv) => request.requestContext.privileges.includes(priv)))
      .map((app) => {
        const navEntries = app.manifest.integration?.ui?.nav_entries ?? [];
        const filtered = navEntries.filter((entry) =>
          (entry.required_privileges ?? []).every((priv) => request.requestContext.privileges.includes(priv)),
        );
        return {
          app_id: app.app_id,
          slug: app.slug,
          ui_url: app.ui_url,
          nav_entries: filtered,
        };
      });

    return reply.send({ items });
  });
}
