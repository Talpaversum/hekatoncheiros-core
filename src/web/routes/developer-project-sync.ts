import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { FastifyInstance, FastifyRequest } from "fastify";

import { hasPrivilege } from "../../access/privileges.js";
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
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const project = async (request: FastifyRequest, id: string) => {
  const result = await getPool().query(
    "select * from core.local_app_projects where project_id=$1 and tenant_id=$2",
    [id, request.requestContext.tenant.tenantId],
  );
  if (!result.rowCount) throw new NotFoundError("Developer project not found");
  return result.rows[0];
};
const significant = (manifest: Record<string, unknown>) => ({
  privileges: manifest["privileges"],
  integration: manifest["integration"],
  licensing: manifest["licensing"],
  runtime: manifest["runtime"],
  base_url: manifest["base_url"],
});
const diff = (before: Record<string, unknown> | null, after: Record<string, unknown>) => ({
  manifest: {
    changed: hash(before) !== hash(after),
    before_hash: before ? hash(before) : null,
    after_hash: hash(after),
  },
  runtime: {
    changed: hash(before ? significant(before) : null) !== hash(significant(after)),
    before: before ? significant(before) : null,
    after: significant(after),
  },
});

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
    return { revision: `workspace:${hash(raw)}`, manifest };
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
      const changes = diff(previous, source.manifest as Record<string, unknown>);
      const sameRevision = row["source_revision"] === source.revision;
      const sameManifest = row["manifest_hash"] === hash(source.manifest);
      const status = sameRevision
        ? "up_to_date"
        : sameManifest
          ? "update_available"
          : changes.runtime.changed
            ? "runtime_approval_required"
            : "validation_required";
      const baseUrl =
        typeof source.manifest["base_url"] === "string"
          ? normalizeTrustedOrigin(source.manifest["base_url"])
          : null;
      const result = await getPool().query(
        "update core.local_app_projects set source_revision=$3,synced_manifest_json=$4::jsonb,pending_diff_json=$5::jsonb,last_sync_at=now(),update_status=$6,origin_url=coalesce(origin_url,$7),updated_at=now() where project_id=$1 and tenant_id=$2 returning *",
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
