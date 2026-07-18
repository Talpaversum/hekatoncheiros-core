import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { hasPrivilege } from "../../access/privileges.js";
import { buildManifestHash } from "../../apps/manifest-fetcher.js";
import { validateManifest, type AppManifest } from "../../apps/manifest-validator.js";
import { getPool } from "../../db/pool.js";
import { findAccessibleDeveloperConnection } from "../../developer/connection-access.js";
import { appendDeveloperLog } from "../../developer/log-service.js";
import { createDeveloperSourceProvider } from "../../developer/source-provider-adapter.js";
import { canonicalizeWorkspacePath } from "../../developer/source-providers.js";
import { requireInstanceCapability } from "../../platform/instance-capabilities.js";
import { normalizeTrustedOrigin } from "../../platform/trusted-origins-store.js";
import { ForbiddenError, HttpError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const prepare = async (request: FastifyRequest, app: FastifyInstance) => {
  await requireUserAuth(request, app.config);
  requireInstanceCapability(app.config, "privateAppDevelopment");
  if (!hasPrivilege(request.requestContext.privileges, "developer.projects.manage"))
    throw new ForbiddenError();
};
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "undefined")
    .digest("hex");
const rawHash = (value: string) => createHash("sha256").update(value).digest("hex");
const project = async (request: FastifyRequest, id: string) => {
  const result = await getPool().query(
    "select * from core.local_app_projects where project_id=$1 and tenant_id=$2",
    [id, request.requestContext.tenant.tenantId],
  );
  if (!result.rowCount) throw new NotFoundError("Developer project not found");
  return result.rows[0];
};
const at = (manifest: Record<string, unknown> | null, ...path: string[]) =>
  path.reduce<unknown>(
    (value, key) =>
      value && typeof value === "object" ? (value as Record<string, unknown>)[key] : null,
    manifest,
  );
const environmentNames = (manifest: Record<string, unknown> | null) => {
  const value = at(manifest, "runtime", "environment");
  if (Array.isArray(value))
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.split("=", 1)[0]);
  return value && typeof value === "object"
    ? Object.keys(value as Record<string, unknown>).sort()
    : [];
};
const safeRuntime = (manifest: Record<string, unknown> | null) => {
  const runtime = at(manifest, "runtime");
  if (!runtime || typeof runtime !== "object") return runtime ?? null;
  return Object.fromEntries(
    Object.entries(runtime as Record<string, unknown>).map(([key, value]) => [
      key,
      key === "environment"
        ? environmentNames(manifest)
        : /secret|token|password|private.?key|credential/i.test(key)
          ? "[REDACTED]"
          : value,
    ]),
  );
};
const change = (before: unknown, after: unknown, securitySignificant = false) => ({
  changed: hash(before) !== hash(after),
  before: before ?? null,
  after: after ?? null,
  security_significant: securitySignificant,
});
export const buildDeveloperProjectDiff = (
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  managedRevisionChanged: boolean,
  approvalApplicable: boolean,
) => {
  const fields = {
    api_routes: change(
      at(before, "integration", "api", "exposes"),
      at(after, "integration", "api", "exposes"),
    ),
    ui_entrypoint: change(
      at(before, "integration", "ui", "artifact"),
      at(after, "integration", "ui", "artifact"),
    ),
    permissions: change(at(before, "privileges"), at(after, "privileges"), true),
    capabilities: change(at(before, "capabilities"), at(after, "capabilities"), true),
    origin: change(at(before, "base_url"), at(after, "base_url"), true),
    docker_image: change(at(before, "runtime", "image"), at(after, "runtime", "image"), true),
    ports: change(at(before, "runtime", "ports"), at(after, "runtime", "ports"), true),
    volumes: change(at(before, "runtime", "volumes"), at(after, "runtime", "volumes"), true),
    environment_variables: change(environmentNames(before), environmentNames(after), true),
    licensing: change(at(before, "licensing"), at(after, "licensing"), true),
  };
  const securityChanged = Object.values(fields).some(
    (item) => item.changed && item.security_significant,
  );
  return {
    manifest: {
      changed: before ? buildManifestHash(before) !== buildManifestHash(after) : true,
      before_hash: before ? buildManifestHash(before) : null,
      after_hash: buildManifestHash(after),
    },
    ...fields,
    runtime: {
      changed:
        managedRevisionChanged ||
        securityChanged ||
        hash(at(before, "runtime")) !== hash(at(after, "runtime")),
      managed_source_revision_changed: managedRevisionChanged,
      before: safeRuntime(before),
      after: safeRuntime(after),
    },
    requires_runtime_approval: approvalApplicable && (managedRevisionChanged || securityChanged),
  };
};
export function resolveDeveloperUpdateStatus(input: {
  sameRevision: boolean;
  sameManifest: boolean;
  requiresRuntimeApproval: boolean;
}) {
  return input.sameRevision && input.sameManifest
    ? "up_to_date"
    : input.requiresRuntimeApproval
      ? "runtime_approval_required"
      : input.sameManifest
        ? "deployment_required"
        : "validation_required";
}

async function readSource(
  app: FastifyInstance,
  request: FastifyRequest,
  row: Record<string, unknown>,
) {
  const type = String(row["source_type"]);
  if (type === "local_workspace") {
    const connection = await findAccessibleDeveloperConnection(
      request,
      row["source_connection_id"],
      "local_workspace",
    );
    const workspace = await canonicalizeWorkspacePath(String(row["workspace_path"]), app.config);
    const connectionRoot = String(
      (connection["metadata_json"] as Record<string, unknown>)["canonical_path"],
    );
    const connectionChild = relative(connectionRoot, workspace);
    if (connectionChild.startsWith("..") || isAbsolute(connectionChild)) {
      throw new ForbiddenError("Workspace is outside the selected connection root");
    }
    const path = resolve(workspace, String(row["manifest_path"] || "manifest/app-manifest.json"));
    const child = relative(workspace, path);
    if (child.startsWith("..") || isAbsolute(child))
      throw new ForbiddenError("Manifest path escapes the workspace");
    const raw = await readFile(path, "utf8");
    const manifest = JSON.parse(raw) as AppManifest;
    await validateManifest(manifest);
    return { revision: `workspace:${rawHash(raw)}`, manifest };
  }
  if (type === "github" || type === "gitlab" || type === "git") {
    const item = await findAccessibleDeveloperConnection(
      request,
      row["source_connection_id"],
      type,
    );
    const source = await createDeveloperSourceProvider(item, app.config).source(
      String(row["repository"]),
      String(row["branch"] || "main"),
      String(row["manifest_path"] || "manifest/app-manifest.json"),
    );
    await getPool().query(
      "update core.developer_connections set last_used_at=now(),updated_at=now() where connection_id=$1",
      [item["connection_id"]],
    );
    await validateManifest(source.manifest);
    return source;
  }
  throw new HttpError(409, "Source synchronization provider is not available for this project yet");
}

export async function registerDeveloperProjectSyncRoutes(app: FastifyInstance) {
  app.post("/developer-projects/:id/sync", async (request, reply) => {
    await prepare(request, app);
    const id = (request.params as { id: string }).id;
    const row = await project(request, id);
    try {
      const source = await readSource(app, request, row);
      const previous =
        (
          row["manifest_result_json"] as {
            selected?: { manifest?: Record<string, unknown> };
          } | null
        )?.selected?.manifest ?? null;
      const sameRevision = row["deployed_revision"] === source.revision;
      const sameManifest = row["manifest_hash"] === buildManifestHash(source.manifest);
      const managedRevisionChanged =
        Boolean(row["deployed_revision"]) &&
        !sameRevision &&
        ["dockerfile", "docker_compose"].includes(String(row["runtime_type"]));
      const changes = buildDeveloperProjectDiff(
        previous,
        source.manifest as Record<string, unknown>,
        managedRevisionChanged,
        Boolean(row["deployed_revision"]),
      );
      const status = resolveDeveloperUpdateStatus({
        sameRevision,
        sameManifest,
        requiresRuntimeApproval: changes.requires_runtime_approval,
      });
      const baseUrl =
        typeof source.manifest["base_url"] === "string"
          ? normalizeTrustedOrigin(source.manifest["base_url"])
          : null;
      const result = await getPool().query(
        "update core.local_app_projects set source_revision=$3,synced_manifest_json=$4::jsonb,pending_diff_json=$5::jsonb,last_sync_at=now(),update_status=$6,origin_url=coalesce(origin_url,$7),runtime_approval_hash=null,runtime_approved_by=null,runtime_approved_at=null,updated_at=now() where project_id=$1 and tenant_id=$2 returning *",
        [
          id,
          request.requestContext.tenant.tenantId,
          source.revision,
          JSON.stringify(source.manifest),
          JSON.stringify(changes),
          status,
          baseUrl,
        ],
      );
      await appendDeveloperLog({
        tenantId: request.requestContext.tenant.tenantId,
        projectId: id,
        category: "source_sync",
        level: "info",
        message: `Source synchronized at revision ${source.revision}`,
      });
      return reply.send(result.rows[0]);
    } catch (error) {
      await appendDeveloperLog({
        tenantId: request.requestContext.tenant.tenantId,
        projectId: id,
        category: "source_sync",
        level: "error",
        message: error instanceof Error ? error.message : "Source synchronization failed",
      });
      throw error;
    }
  });
  app.get("/developer-projects/:id/diff", async (request, reply) => {
    await prepare(request, app);
    const row = await project(request, (request.params as { id: string }).id);
    return reply.send(
      row["pending_diff_json"] ?? { manifest: { changed: false }, runtime: { changed: false } },
    );
  });
}
