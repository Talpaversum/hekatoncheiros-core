import type { FastifyInstance } from "fastify";

import { hasAllPrivileges } from "../../access/privileges.js";
import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { hasSelectedActiveLicense } from "../../licensing/license-service.js";
import { requireUserAuth } from "../plugins/auth-user.js";

function readStringField(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  const value = (source as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function requiresLicense(app: { manifest?: { licensing?: { required?: boolean } } }): boolean {
  return app.manifest?.licensing?.required === true;
}

function readHelpEntries(app: {
  manifest?: {
    integration?: {
      ui?: {
        help_entries?: Array<{
          title: string;
          summary: string;
          outcome?: string;
          category?: string;
          steps: string[];
          path: string;
          required_privileges?: string[];
        }>;
      };
    };
  };
}) {
  return app.manifest?.integration?.ui?.help_entries ?? [];
}

export async function registerAppRegistryRoutes(app: FastifyInstance) {
  app.get("/apps/registry", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const tenantId = request.requestContext.tenant.tenantId;
    const store = getAppInstallationStore();
    const apps = await store.listInstalledApps();

    const entitledAppIds = new Set<string>();
    await Promise.all(
      apps.map(async (installedApp) => {
        const hasLicense = await hasSelectedActiveLicense(tenantId, installedApp.app_id);
        if (hasLicense) {
          entitledAppIds.add(installedApp.app_id);
        }
      }),
    );

    const items = apps
      .filter((app) => app.enabled !== false)
      .filter((app) => !requiresLicense(app) || entitledAppIds.has(app.app_id))
      .filter((app) => hasAllPrivileges(request.requestContext.privileges, app.required_privileges))
      .map((app) => {
        const navEntries = app.nav_entries ?? app.manifest.integration?.ui?.nav_entries ?? [];
        const filtered = navEntries.filter((entry) =>
          hasAllPrivileges(request.requestContext.privileges, entry.required_privileges ?? []),
        );
        const helpEntries = readHelpEntries(app).filter((entry) =>
          hasAllPrivileges(request.requestContext.privileges, entry.required_privileges ?? []),
        );
        return {
          app_id: app.app_id,
          app_name: readStringField(app.manifest, "app_name"),
          slug: app.slug,
          ui_url: app.ui_url,
          localization: app.manifest.localization ?? {
            contract_version: 1,
            default_locale: "en",
            supported_locales: ["en"],
            resources: [],
          },
          nav_entries: filtered,
          help_entries: helpEntries,
        };
      });

    return reply.send({ items });
  });
}
