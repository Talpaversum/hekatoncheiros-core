import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { getAppCatalogStore } from "../../apps/app-catalog-store.js";
import { getAppInstallationStore } from "../../apps/app-installation-service.js";
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

function requireAppCatalogManage(request: { requestContext: { privileges: string[] } }) {
  if (!hasPrivilege(request.requestContext.privileges, "platform.apps.manage")) {
    throw new ForbiddenError();
  }
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
