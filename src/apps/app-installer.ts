import { recordAudit } from "../audit/audit-service.js";
import type { EnvConfig } from "../config/index.js";
import { getAppInstallationStore } from "./app-installation-service.js";
import { issueInstallerToken } from "./installer-token.js";
import type { FetchManifestResult } from "./manifest-fetcher.js";
import { saveUiPluginArtifact } from "./ui-artifact-storage.js";

export type InstallFetchedAppInput = {
  fetched: FetchManifestResult;
  config: EnvConfig;
  tenantId: string;
  actorUserId: string;
  effectiveUserId: string;
};

export async function installFetchedApp(input: InstallFetchedAppInput): Promise<{ status: "installed"; app_id: string }> {
  const { fetched, config, tenantId, actorUserId, effectiveUserId } = input;
  const manifest = fetched.manifest;
  const manifestAppId = manifest["app_id"];
  if (typeof manifestAppId !== "string" || manifestAppId.trim().length === 0) {
    throw new Error("manifest app_id missing");
  }

  const appId = manifestAppId;
  const integration = manifest["integration"] as {
    slug?: string;
    api?: { exposes?: { base_path?: string } };
    ui?: {
      artifact?: { url?: string; auth?: string };
      nav_entries?: Array<{ label: string; path: string; required_privileges?: string[] }>;
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
  const slug = integration?.slug;
  const basePath = integration?.api?.exposes?.base_path;
  const artifactPath = integration?.ui?.artifact?.url;
  const artifactAuth = integration?.ui?.artifact?.auth;
  if (!slug || !basePath || !artifactPath || !artifactAuth) {
    throw new Error("manifest integration.slug, integration.api.exposes.base_path, integration.ui.artifact.url and integration.ui.artifact.auth are required");
  }

  if (artifactAuth !== "core-signed-token") {
    throw new Error("integration.ui.artifact.auth must be core-signed-token");
  }

  const normalizedBasePath = `/apps/${slug}`;
  if (basePath !== normalizedBasePath) {
    throw new Error("integration.api.exposes.base_path must match slug");
  }

  const artifactUrl = new URL(artifactPath, fetched.normalizedBaseUrl);
  const unauthenticatedResponse = await fetch(artifactUrl);
  if (unauthenticatedResponse.status !== 401 && unauthenticatedResponse.status !== 403) {
    throw new Error(`artifact endpoint misconfigured: unauthenticated fetch must return 401/403, got ${unauthenticatedResponse.status}`);
  }

  const installerToken = await issueInstallerToken({ appId, slug, config });
  const authenticatedResponse = await fetch(artifactUrl, {
    headers: {
      authorization: `Bearer ${installerToken}`,
    },
  });

  if (authenticatedResponse.status !== 200) {
    throw new Error(`artifact download failed with installer token: expected 200, got ${authenticatedResponse.status}`);
  }

  const artifactContent = Buffer.from(await authenticatedResponse.arrayBuffer());
  if (artifactContent.length === 0) {
    throw new Error("artifact download failed: empty response body");
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
    throw new Error("slug already in use");
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
  const rawHelpEntries = (integration.ui?.help_entries ?? []) as Array<{
    title: string;
    summary: string;
    outcome?: string;
    category?: string;
    steps: string[];
    path: string;
    required_privileges?: string[];
  }>;
  const helpEntries = rawHelpEntries.map((entry) => {
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
    manifest_hash: fetched.manifestHash,
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
          help_entries: helpEntries,
        },
      },
    },
  });

  await recordAudit({
    tenantId,
    actorUserId,
    effectiveUserId,
    action: "platform.apps.install",
    objectRef: appId,
    metadata: {
      base_url: fetched.normalizedBaseUrl,
      slug,
      app_version: fetched.appVersion,
      manifest_version: fetched.manifestVersion,
    },
  });

  return { status: "installed", app_id: appId };
}
