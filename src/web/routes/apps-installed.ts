import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { getAppCatalogStore } from "../../apps/app-catalog-store.js";
import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { installFetchedApp } from "../../apps/app-installer.js";
import {
  isDockerComposeRuntimeEnabled,
  removeDockerComposeAppRuntime,
  stopDockerComposeAppRuntime,
} from "../../apps/app-runtime-docker-compose.js";
import { getAppRuntimeInstallation } from "../../apps/app-runtime-installation-store.js";
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
import { requireAppAuth } from "../plugins/auth-app.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const fetchManifestSchema = z.object({
  base_url: z.string().url(),
});

const installSchema = z.object({
  base_url: z.string().url(),
  expected_manifest_hash: z.string().trim().regex(/^[a-f0-9]{64}$/i),
});

const updateSignalSchema = z.object({
  source: z.enum(["app", "feed", "manual"]).default("app"),
  app_version: z.string().trim().min(1).max(120).optional(),
  manifest_hash: z.string().trim().regex(/^[a-f0-9]{64}$/i).optional(),
  manifest_url: z.string().trim().url().optional(),
  note: z.string().trim().max(500).optional(),
});

const APP_TOKEN_TTL_SECONDS = 60 * 15;

function readTime(value?: string | null): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function buildExpiry(secondsFromNow: number) {
  return new Date(Date.now() + secondsFromNow * 1000);
}

async function issueAppAccessToken(params: {
  appId: string;
  tenantId: string;
  config: FastifyInstance["config"];
}) {
  const secret = new TextEncoder().encode(params.config.JWT_SECRET);
  const expiresAt = buildExpiry(APP_TOKEN_TTL_SECONDS);
  const jwt = await new SignJWT({
    app_id: params.appId,
    tenant_id: params.tenantId,
    purpose: "core-api",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(params.appId)
    .setIssuer(params.config.JWT_ISSUER)
    .setAudience(params.config.JWT_AUDIENCE_APP)
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret);

  return { jwt, expiresAt };
}

async function upsertUpdateSignal(params: {
  appId: string;
  source: "app" | "feed" | "manual";
  appVersion?: string;
  manifestHash?: string;
  manifestUrl?: string;
  note?: string;
}) {
  const result = await getPool().query(
    `insert into core.app_update_signals (
       app_id,
       source,
       reported_app_version,
       reported_manifest_hash,
       reported_manifest_url,
       note,
       reported_at,
       cleared_at
     )
     values ($1, $2, $3, $4, $5, $6, now(), null)
     on conflict (app_id)
     do update set
       source = excluded.source,
       reported_app_version = excluded.reported_app_version,
       reported_manifest_hash = excluded.reported_manifest_hash,
       reported_manifest_url = excluded.reported_manifest_url,
       note = excluded.note,
       reported_at = now(),
       cleared_at = null
     returning app_id, source, reported_app_version, reported_manifest_hash, reported_manifest_url, note, reported_at`,
    [
      params.appId,
      params.source,
      params.appVersion ?? null,
      params.manifestHash ?? null,
      params.manifestUrl ?? null,
      params.note ?? null,
    ],
  );
  const row = result.rows[0];
  return {
    app_id: row.app_id as string,
    source: row.source as "app" | "feed" | "manual",
    app_version: row.reported_app_version as string | null,
    manifest_hash: row.reported_manifest_hash as string | null,
    manifest_url: row.reported_manifest_url as string | null,
    note: row.note as string | null,
    reported_at: new Date(row.reported_at).toISOString(),
  };
}

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
    const catalogEntries = await getAppCatalogStore().listEntries();
    const catalogByAppId = new Map(catalogEntries.map((entry) => [entry.app_id, entry]));
    const updateSignalsResult = await getPool().query(
      `select app_id, source, reported_app_version, reported_manifest_hash, reported_manifest_url, note, reported_at
       from core.app_update_signals
       where cleared_at is null`,
    );
    const updateSignalsByAppId = new Map(
      updateSignalsResult.rows.map((row) => [
        row.app_id as string,
        {
          source: row.source as "app" | "feed" | "manual",
          app_version: row.reported_app_version as string | null,
          manifest_hash: row.reported_manifest_hash as string | null,
          manifest_url: row.reported_manifest_url as string | null,
          note: row.note as string | null,
          reported_at: new Date(row.reported_at).toISOString(),
        },
      ]),
    );
    const tenantId = request.requestContext.tenant.tenantId;

    const items = await Promise.all(
      apps.map(async (installedApp) => {
        const [selectedLicense, anyLicense] = await Promise.all([
          getSelectedTenantLicense(tenantId, installedApp.app_id),
          hasAnyTenantLicense(tenantId, installedApp.app_id),
        ]);

        return {
          ...installedApp,
          catalog_update: catalogByAppId.has(installedApp.app_id)
            ? (() => {
                const entry = catalogByAppId.get(installedApp.app_id)!;
                const hashesMatch = installedApp.manifest_hash === entry.manifest_hash;
                const catalogFetchedAt = readTime(entry.fetched_at);
                const installedFetchedAt = readTime(installedApp.fetched_at);
                const isCatalogNewer =
                  catalogFetchedAt !== null && installedFetchedAt !== null
                    ? catalogFetchedAt > installedFetchedAt
                    : !hashesMatch;
                const state = !installedApp.manifest_hash
                  ? "baseline_missing"
                  : hashesMatch
                    ? "same"
                    : isCatalogNewer
                      ? "available"
                      : "stale";
                return {
                  state,
                  update_available: state === "baseline_missing" ? null : state === "available",
                  app_version: entry.app_version,
                  manifest_hash: entry.manifest_hash,
                  fetched_at: entry.fetched_at,
                  source_type: entry.source_type,
                  trust_status: entry.trust_status,
                };
              })()
            : null,
          update_signal: updateSignalsByAppId.has(installedApp.app_id)
            ? (() => {
                const signal = updateSignalsByAppId.get(installedApp.app_id)!;
                return {
                  ...signal,
                  update_available: signal.manifest_hash
                    ? installedApp.manifest_hash
                      ? installedApp.manifest_hash !== signal.manifest_hash
                      : null
                    : null,
                };
              })()
            : null,
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
      await getPool().query("update core.app_update_signals set cleared_at = now() where app_id = $1", [appId]);
      return reply.send({
        ...result,
        refreshed_at: new Date().toISOString(),
      });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.post("/apps/installed/:app_id/check-update", async (request, reply) => {
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
      return reply.code(409).send({ message: "fetched manifest app_id does not match installed app" });
    }

    return reply.send({
      app_id: appId,
      checked_at: new Date().toISOString(),
      update_available: installed.manifest_hash ? installed.manifest_hash !== fetched.manifestHash : null,
      installed: {
        app_version: installed.app_version ?? null,
        manifest_hash: installed.manifest_hash ?? null,
        fetched_at: installed.fetched_at ?? null,
      },
      fetched: {
        app_version: fetched.appVersion,
        manifest_hash: fetched.manifestHash,
        fetched_at: fetched.fetchedAt,
        fetched_from_url: fetched.fetchedFromUrl,
      },
    });
  });

  app.post("/apps/installed/:app_id/app-token", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!hasPrivilege(request.requestContext.privileges, "platform.apps.manage")) {
      throw new ForbiddenError();
    }

    const appId = (request.params as { app_id: string }).app_id;
    const installed = await getAppInstallationStore().getApp(appId);
    if (!installed) {
      throw new NotFoundError("App not installed");
    }

    const tenantId = request.requestContext.tenant.tenantId;
    const token = await issueAppAccessToken({ appId, tenantId, config });

    await recordAudit({
      tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "platform.apps.app_token.issue",
      objectRef: appId,
      metadata: {
        app_id: appId,
        expires_at: token.expiresAt.toISOString(),
      },
    });

    return reply.send({
      app_id: appId,
      token_type: "Bearer",
      access_token: token.jwt,
      expires_at: token.expiresAt.toISOString(),
    });
  });

  app.post("/apps/installed/update-signal", async (request, reply) => {
    const config = app.config;
    await requireAppAuth(request, config);

    const appId = request.requestContext.actor.appId;
    if (!appId) {
      throw new ForbiddenError("App token missing app_id");
    }

    const installed = await getAppInstallationStore().getApp(appId);
    if (!installed) {
      throw new NotFoundError("App not installed");
    }

    const parsed = updateSignalSchema.omit({ source: true }).parse(request.body);
    const signal = await upsertUpdateSignal({
      appId,
      source: "app",
      appVersion: parsed.app_version,
      manifestHash: parsed.manifest_hash,
      manifestUrl: parsed.manifest_url,
      note: parsed.note,
    });

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: null,
      effectiveUserId: null,
      action: "platform.apps.update_signal.record",
      objectRef: appId,
      metadata: {
        app_id: appId,
        source: "app",
        app_version: parsed.app_version ?? null,
        manifest_hash: parsed.manifest_hash ?? null,
        actor_app_id: appId,
      },
    });

    return reply.send(signal);
  });

  app.post("/apps/installed/:app_id/update-signal", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!hasPrivilege(request.requestContext.privileges, "platform.apps.manage")) {
      throw new ForbiddenError();
    }

    const appId = (request.params as { app_id: string }).app_id;
    const installed = await getAppInstallationStore().getApp(appId);
    if (!installed) {
      throw new NotFoundError("App not installed");
    }

    const parsed = updateSignalSchema.parse(request.body);
    const signal = await upsertUpdateSignal({
      appId,
      source: parsed.source,
      appVersion: parsed.app_version,
      manifestHash: parsed.manifest_hash,
      manifestUrl: parsed.manifest_url,
      note: parsed.note,
    });

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "platform.apps.update_signal.record",
      objectRef: appId,
      metadata: {
        app_id: appId,
        source: parsed.source,
        app_version: parsed.app_version ?? null,
        manifest_hash: parsed.manifest_hash ?? null,
      },
    });

    return reply.send(signal);
  });

  app.delete("/apps/installed/:app_id/update-signal", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!hasPrivilege(request.requestContext.privileges, "platform.apps.manage")) {
      throw new ForbiddenError();
    }

    const appId = (request.params as { app_id: string }).app_id;
    const result = await getPool().query(
      "update core.app_update_signals set cleared_at = now() where app_id = $1 and cleared_at is null",
      [appId],
    );
    if (result.rowCount === 0) {
      throw new NotFoundError("Update signal not found");
    }

    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: "platform.apps.update_signal.clear",
      objectRef: appId,
      metadata: {
        app_id: appId,
      },
    });

    return reply.code(204).send();
  });

  app.post("/apps/installed/:app_id/runtime/stop", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);
    if (!hasPrivilege(request.requestContext.privileges, "platform.apps.runtime.manage")) {
      throw new ForbiddenError();
    }

    const appId = (request.params as { app_id: string }).app_id;
    const installed = await getAppInstallationStore().getApp(appId);
    if (!installed) {
      throw new NotFoundError("App not installed");
    }

    const runtimeInstallation = await getAppRuntimeInstallation(appId);
    if (!runtimeInstallation) {
      return reply.code(409).send({
        message: "App does not have a Core-managed runtime",
        code: "runtime_not_managed",
      });
    }
    if (!isDockerComposeRuntimeEnabled(config)) {
      return reply.code(409).send({
        message: "Docker Compose runtime is disabled",
        code: "runtime_not_enabled",
      });
    }

    try {
      const result = await stopDockerComposeAppRuntime({
        config,
        identity: {
          compose_project: runtimeInstallation.compose_project,
          service_name: runtimeInstallation.service_name,
        },
      });

      await recordAudit({
        tenantId: request.requestContext.tenant.tenantId,
        actorUserId: request.requestContext.actor.userId,
        effectiveUserId: request.requestContext.actor.effectiveUserId,
        action: "platform.apps.runtime.stop",
        objectRef: appId,
        metadata: { app_id: appId, ...result },
      });

      return reply.send({ app_id: appId, ...result });
    } catch (error) {
      return reply.code(400).send({
        message: (error as Error).message,
        code: "runtime_stop_failed",
      });
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
    const installed = await store.getApp(appId);
    if (!installed) {
      throw new NotFoundError("App not installed");
    }

    const runtimeInstallation = await getAppRuntimeInstallation(appId);
    let runtimeRemoval: Awaited<ReturnType<typeof removeDockerComposeAppRuntime>> | null = null;

    if (runtimeInstallation?.runtime_type === "compose") {
      if (!hasPrivilege(request.requestContext.privileges, "platform.apps.runtime.manage")) {
        throw new ForbiddenError();
      }
      if (!isDockerComposeRuntimeEnabled(config)) {
        return reply.code(409).send({
          message: "Docker Compose runtime is disabled",
          code: "runtime_not_enabled",
        });
      }

      try {
        runtimeRemoval = await removeDockerComposeAppRuntime({
          config,
          identity: {
            compose_project: runtimeInstallation.compose_project,
            service_name: runtimeInstallation.service_name,
          },
        });
      } catch (error) {
        return reply.code(400).send({
          message: (error as Error).message,
          code: "runtime_remove_failed",
        });
      }
    }

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
        runtime_removal: runtimeRemoval,
      },
    });

    return reply.code(204).send();
  });
}
