import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { syncCatalogFeedSource } from "../../apps/app-catalog-feed-sync.js";
import { getAppCatalogStore } from "../../apps/app-catalog-store.js";
import { getAppInstallationStore } from "../../apps/app-installation-service.js";
import { installFetchedApp } from "../../apps/app-installer.js";
import { getAppRuntimeHealth } from "../../apps/app-runtime-health.js";
import { fetchManifest, fetchManifestFromUrl, type FetchManifestResult } from "../../apps/manifest-fetcher.js";
import { getPool } from "../../db/pool.js";
import { requireInstanceCapability } from "../../platform/instance-capabilities.js";
import { getTrustedOriginsStore, normalizeTrustedOrigin } from "../../platform/trusted-origins-store.js";
import { ForbiddenError, HttpError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const projectSchema = z.object({
  display_name: z.string().trim().min(2).max(120),
  origin_url: z.string().url(),
  source_type: z.enum(["manifest", "feed"]),
  manifest_url: z.string().url().nullable().optional(),
  feed_url: z.string().url().nullable().optional(),
}).superRefine((value, context) => {
  if (value.source_type === "manifest" && !value.manifest_url) context.addIssue({ code: "custom", path: ["manifest_url"], message: "Manifest URL is required" });
  if (value.source_type === "feed" && !value.feed_url) context.addIssue({ code: "custom", path: ["feed_url"], message: "Feed URL is required" });
  const sourceUrl = value.source_type === "manifest" ? value.manifest_url : value.feed_url;
  if (sourceUrl && new URL(sourceUrl).origin !== new URL(value.origin_url).origin) context.addIssue({ code: "custom", path: [value.source_type === "manifest" ? "manifest_url" : "feed_url"], message: "Source URL must use the application origin" });
});

type ProjectRow = Record<string, unknown>;

function mapProject(row: ProjectRow) {
  return {
    project_id: String(row["project_id"]), tenant_id: String(row["tenant_id"]), created_by: String(row["created_by"]),
    display_name: String(row["display_name"]), origin_url: String(row["origin_url"]), source_type: String(row["source_type"]),
    manifest_url: (row["manifest_url"] as string | null) ?? null, feed_url: (row["feed_url"] as string | null) ?? null,
    status: String(row["status"]), connectivity_result_json: row["connectivity_result_json"] ?? null,
    manifest_result_json: row["manifest_result_json"] ?? null, trusted_origin_id: (row["trusted_origin_id"] as string | null) ?? null,
    installed_app_id: (row["installed_app_id"] as string | null) ?? null,
    created_at: new Date(String(row["created_at"])).toISOString(), updated_at: new Date(String(row["updated_at"])).toISOString(),
  };
}

async function prepare(request: FastifyRequest, app: FastifyInstance) {
  await requireUserAuth(request, app.config);
  requireInstanceCapability(app.config, "privateAppDevelopment");
  if (!hasPrivilege(request.requestContext.privileges, "platform.apps.manage")) throw new ForbiddenError();
}

async function findProject(request: FastifyRequest, projectId: string) {
  const result = await getPool().query("select * from core.local_app_projects where project_id=$1 and tenant_id=$2", [projectId, request.requestContext.tenant.tenantId]);
  if (!result.rowCount) throw new NotFoundError("Developer project not found");
  return result.rows[0] as ProjectRow;
}

const trusted = async (origin: string) => (await getTrustedOriginsStore().listEnabledOrigins()).has(origin);

async function fetchProjectManifest(row: ProjectRow): Promise<FetchManifestResult> {
  if (row["source_type"] === "manifest") return fetchManifestFromUrl(String(row["manifest_url"]), { isTrustedOrigin: trusted });
  const validation = row["manifest_result_json"] as { selected?: { base_url?: string } } | null;
  if (!validation?.selected?.base_url) throw new HttpError(409, "Validate the feed and select its first valid application before installation");
  return fetchManifest(validation.selected.base_url, { isTrustedOrigin: trusted });
}

export async function registerDeveloperProjectRoutes(app: FastifyInstance) {
  app.post("/developer-projects", async (request, reply) => {
    await prepare(request, app); const body = projectSchema.parse(request.body); const projectId = `local_${randomUUID().replaceAll("-", "")}`;
    const origin = normalizeTrustedOrigin(body.origin_url);
    const result = await getPool().query(
      `insert into core.local_app_projects(project_id,tenant_id,created_by,display_name,origin_url,source_type,manifest_url,feed_url)
       values($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
      [projectId, request.requestContext.tenant.tenantId, request.requestContext.actor.userId, body.display_name, origin, body.source_type, body.source_type === "manifest" ? body.manifest_url : null, body.source_type === "feed" ? body.feed_url : null],
    );
    return reply.code(201).send(mapProject(result.rows[0]));
  });

  app.get("/developer-projects", async (request, reply) => {
    await prepare(request, app);
    const result = await getPool().query("select * from core.local_app_projects where tenant_id=$1 order by updated_at desc", [request.requestContext.tenant.tenantId]);
    return reply.send({ items: result.rows.map(mapProject) });
  });

  app.get("/developer-projects/:id", async (request, reply) => {
    await prepare(request, app); return reply.send(mapProject(await findProject(request, (request.params as { id: string }).id)));
  });

  app.put("/developer-projects/:id", async (request, reply) => {
    await prepare(request, app); const projectId = (request.params as { id: string }).id; await findProject(request, projectId); const body = projectSchema.parse(request.body);
    const result = await getPool().query(
      `update core.local_app_projects set display_name=$3,origin_url=$4,source_type=$5,manifest_url=$6,feed_url=$7,status='draft',connectivity_result_json=null,manifest_result_json=null,trusted_origin_id=null,installed_app_id=null,updated_at=now()
       where project_id=$1 and tenant_id=$2 returning *`,
      [projectId, request.requestContext.tenant.tenantId, body.display_name, normalizeTrustedOrigin(body.origin_url), body.source_type, body.source_type === "manifest" ? body.manifest_url : null, body.source_type === "feed" ? body.feed_url : null],
    );
    return reply.send(mapProject(result.rows[0]));
  });

  app.post("/developer-projects/:id/test-origin", async (request, reply) => {
    await prepare(request, app); const row = await findProject(request, (request.params as { id: string }).id); const started = Date.now(); let result: Record<string, unknown>;
    try { const response = await fetch(String(row["origin_url"]), { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5000) }); result = { reachable: true, status_code: response.status, latency_ms: Date.now() - started, checked_at: new Date().toISOString() }; }
    catch (error) { result = { reachable: false, status_code: null, latency_ms: Date.now() - started, checked_at: new Date().toISOString(), error: error instanceof Error ? error.message : "Connection failed" }; }
    const updated = await getPool().query("update core.local_app_projects set status=$3,connectivity_result_json=$4::jsonb,updated_at=now() where project_id=$1 and tenant_id=$2 returning *", [row["project_id"], row["tenant_id"], result["reachable"] ? "connectivity_ok" : "connectivity_failed", JSON.stringify(result)]);
    return reply.send(mapProject(updated.rows[0]));
  });

  app.post("/developer-projects/:id/trust-origin", async (request, reply) => {
    await prepare(request, app); const { confirmed } = z.object({ confirmed: z.literal(true) }).parse(request.body); void confirmed;
    const row = await findProject(request, (request.params as { id: string }).id); const connectivity = row["connectivity_result_json"] as { reachable?: boolean } | null;
    if (!connectivity?.reachable) throw new HttpError(409, "A successful connectivity test is required before trusting the origin");
    const store = getTrustedOriginsStore(); const origin = String(row["origin_url"]); const existing = (await store.list()).find((item) => item.origin.toLowerCase() === origin.toLowerCase());
    const trustedOrigin = existing ? (existing.is_enabled ? existing : await store.update(existing.id, { is_enabled: true })) : await store.create({ origin, note: `Private developer project: ${row["display_name"]}`, createdBy: request.requestContext.actor.userId });
    const updated = await getPool().query("update core.local_app_projects set status='origin_trusted',trusted_origin_id=$3,updated_at=now() where project_id=$1 and tenant_id=$2 returning *", [row["project_id"], row["tenant_id"], trustedOrigin?.id]);
    return reply.send(mapProject(updated.rows[0]));
  });

  app.post("/developer-projects/:id/validate-source", async (request, reply) => {
    await prepare(request, app); const row = await findProject(request, (request.params as { id: string }).id);
    if (!row["trusted_origin_id"]) throw new HttpError(409, "Trust the application origin before validating its source");
    let validation: Record<string, unknown>;
    try {
      if (row["source_type"] === "manifest") {
        const fetched = await fetchManifestFromUrl(String(row["manifest_url"]), { isTrustedOrigin: trusted });
        validation = { valid: true, errors: [], selected: { app_id: fetched.manifest["app_id"], app_name: fetched.manifest["app_name"], base_url: fetched.normalizedBaseUrl, manifest_url: fetched.fetchedFromUrl, manifest_hash: fetched.manifestHash, manifest: fetched.manifest } };
      } else {
        const source = await getAppCatalogStore().createFeedSource({ name: `Private project: ${row["display_name"]}`, feedUrl: String(row["feed_url"]), trustMode: "dev", createdBy: request.requestContext.actor.userId });
        const synced = await syncCatalogFeedSource({ source, actorUserId: request.requestContext.actor.userId, config: app.config, isTrustedOrigin: trusted });
        const first = synced.items[0]; validation = { valid: synced.errors.length === 0 && Boolean(first), errors: synced.errors.map((error) => error.message), feed: { total: synced.total, imported: synced.imported }, selected: first ? { app_id: first.app_id, app_name: first.app_name, base_url: first.base_url, manifest_url: first.manifest_url, manifest_hash: first.manifest_hash } : null };
      }
    } catch (error) { validation = { valid: false, errors: [error instanceof Error ? error.message : "Source validation failed"] }; }
    const updated = await getPool().query("update core.local_app_projects set status=$3,manifest_result_json=$4::jsonb,updated_at=now() where project_id=$1 and tenant_id=$2 returning *", [row["project_id"], row["tenant_id"], validation["valid"] ? "source_valid" : "source_invalid", JSON.stringify(validation)]);
    return reply.send(mapProject(updated.rows[0]));
  });

  app.post("/developer-projects/:id/install", async (request, reply) => {
    await prepare(request, app); const row = await findProject(request, (request.params as { id: string }).id); const validation = row["manifest_result_json"] as { valid?: boolean; selected?: { manifest_hash?: string } } | null;
    if (row["status"] !== "source_valid" || !validation?.valid) throw new HttpError(409, "A valid manifest or feed is required before installation");
    const fetched = await fetchProjectManifest(row); if (validation.selected?.manifest_hash !== fetched.manifestHash) throw new HttpError(409, "Manifest changed after validation; validate the source again");
    const installed = await installFetchedApp({ fetched, config: app.config, tenantId: request.requestContext.tenant.tenantId, actorUserId: request.requestContext.actor.userId, effectiveUserId: request.requestContext.actor.effectiveUserId });
    const updated = await getPool().query("update core.local_app_projects set status='installed',installed_app_id=$3,updated_at=now() where project_id=$1 and tenant_id=$2 returning *", [row["project_id"], row["tenant_id"], installed.app_id]);
    return reply.code(201).send(mapProject(updated.rows[0]));
  });

  app.get("/developer-projects/:id/runtime-status", async (request, reply) => {
    await prepare(request, app); const row = await findProject(request, (request.params as { id: string }).id); const appId = row["installed_app_id"] as string | null;
    if (!appId) throw new HttpError(409, "Project is not installed"); const installed = await getAppInstallationStore().getApp(appId); if (!installed) throw new NotFoundError("Installed application not found");
    return reply.send({ app_id: appId, slug: installed.slug, ui_url: installed.ui_url, open_url: `/app/${installed.slug}`, local: true, trust_status: "unverified", runtime: getAppRuntimeHealth(appId) });
  });
}
