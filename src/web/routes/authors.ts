import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { issueAppUserDelegation } from "../../apps/app-user-delegation.js";
import { recordAudit } from "../../audit/audit-service.js";
import {
  fetchAuthorRegistryTrust,
  fetchRegistryAudit,
  fetchRegistryAuthors,
  fetchRegistryDashboard,
  fetchRegistryAuthorDetail,
  onboardAuthor,
  rotateAuthorKeys,
  updateRegistryAuthor,
  mutateRegistryLifecycle,
} from "../../authors/author-registry-client.js";
import { getPool } from "../../db/pool.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";
import { refreshStoredLicenseStatuses } from "../../licensing/license-service.js";

async function registryDelegation(app: FastifyInstance, request: Parameters<typeof requireUserAuth>[0]) {
  const user = await getPool().query("select email from core.users where id=$1 limit 1", [request.requestContext.actor.userId]);
  return issueAppUserDelegation({
    appId: app.config.AUTHOR_REGISTRY_APP_ID,
    context: request.requestContext,
    username: String(user.rows[0]?.email ?? request.requestContext.actor.userId),
    correlationId: request.id,
    config: app.config,
  });
}

const publicJwksSchema = z.object({
  keys: z.array(z.record(z.string(), z.unknown())).min(1).max(20),
});
const onboardingSchema = z.object({
  display_name: z.string().trim().min(2).max(120),
  jwks: publicJwksSchema,
  cert_ttl_days: z.number().int().min(1).max(3650).default(365),
});
const keysSchema = z.object({
  jwks: publicJwksSchema,
  cert_ttl_days: z.number().int().min(1).max(3650).default(365),
});

function requireAuthorManage(request: { requestContext: { privileges: string[] } }) {
  if (!hasPrivilege(request.requestContext.privileges, "platform.authors.manage")) {
    throw new ForbiddenError();
  }
}

export async function registerAuthorRoutes(app: FastifyInstance) {
  app.get("/platform/authors", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAuthorManage(request);
    const result = await getPool().query(
      `select author_id, display_name, public_jwks_json, author_cert_jws, root_kid,
              registry_url, created_by, created_at, updated_at
         from core.author_onboardings order by display_name, author_id`,
    );
    return reply.send({ items: result.rows });
  });

  app.post("/platform/authors/onboard", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAuthorManage(request);
    const parsed = onboardingSchema.parse(request.body);
    try {
      const issued = await onboardAuthor({
        config: app.config,
        displayName: parsed.display_name,
        operatingMode: "trusted_self_hosted",
        jwks: parsed.jwks,
        ttlDays: parsed.cert_ttl_days,
        delegatedUserToken: await registryDelegation(app, request),
      });
      await getPool().query(
        `insert into core.author_onboardings (
           author_id, display_name, public_jwks_json, author_cert_jws, root_kid,
           registry_url, created_by
         ) values ($1, $2, $3::jsonb, $4, $5, $6, $7)`,
        [
          issued.author_id,
          issued.display_name,
          JSON.stringify(parsed.jwks),
          issued.author_cert_jws,
          issued.root_kid,
          app.config.AUTHOR_REGISTRY_URL,
          request.requestContext.actor.userId,
        ],
      );
      await recordAudit({
        tenantId: request.requestContext.tenant.tenantId,
        actorUserId: request.requestContext.actor.userId,
        effectiveUserId: request.requestContext.actor.effectiveUserId,
        action: "platform.authors.onboard",
        objectRef: issued.author_id,
        metadata: {
          author_id: issued.author_id,
          display_name: issued.display_name,
          root_kid: issued.root_kid,
          key_count: parsed.jwks.keys.length,
        },
      });
      return reply.code(201).send(issued);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.post("/platform/authors/:author_id/keys", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAuthorManage(request);
    const authorId = (request.params as { author_id: string }).author_id;
    const parsed = keysSchema.parse(request.body);
    const existing = await getPool().query(
      "select display_name from core.author_onboardings where author_id = $1",
      [authorId],
    );
    if (!existing.rowCount) {
      throw new NotFoundError("Author onboarding not found");
    }
    try {
      const issued = await rotateAuthorKeys({
        config: app.config,
        authorId,
        jwks: parsed.jwks,
        ttlDays: parsed.cert_ttl_days,
        delegatedUserToken: await registryDelegation(app, request),
      });
      await getPool().query(
        `update core.author_onboardings
            set public_jwks_json = $2::jsonb, author_cert_jws = $3,
                root_kid = $4, updated_at = now()
          where author_id = $1`,
        [authorId, JSON.stringify(parsed.jwks), issued.author_cert_jws, issued.root_kid],
      );
      await recordAudit({
        tenantId: request.requestContext.tenant.tenantId,
        actorUserId: request.requestContext.actor.userId,
        effectiveUserId: request.requestContext.actor.effectiveUserId,
        action: "platform.authors.keys.rotate",
        objectRef: authorId,
        metadata: { author_id: authorId, root_kid: issued.root_kid, key_count: parsed.jwks.keys.length },
      });
      return reply.send({ author_id: authorId, ...issued });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.post("/platform/author-registry/sync-trust", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAuthorManage(request);
    try {
      const snapshot = await fetchAuthorRegistryTrust(app.config);
      await getPool().query(
        `insert into core.author_registry_snapshots (
         registry_url, root_jwks_json, revocations_json, synced_at, synced_by
         , trust_anchor_json) values ($1, $2::jsonb, $3::jsonb, now(), $4, $5::jsonb)
         on conflict (registry_url) do update set
           root_jwks_json = excluded.root_jwks_json,
           revocations_json = excluded.revocations_json,
           trust_anchor_json = excluded.trust_anchor_json,
           synced_at = now(), synced_by = excluded.synced_by`,
        [
          app.config.AUTHOR_REGISTRY_URL,
          JSON.stringify(snapshot.rootJwks),
          JSON.stringify(snapshot.revocations),
          request.requestContext.actor.userId,
          JSON.stringify(snapshot.trustAnchor),
        ],
      );
      await recordAudit({
        tenantId: request.requestContext.tenant.tenantId,
        actorUserId: request.requestContext.actor.userId,
        effectiveUserId: request.requestContext.actor.effectiveUserId,
        action: "platform.authors.trust.sync",
        objectRef: app.config.AUTHOR_REGISTRY_URL,
        metadata: { registry_url: app.config.AUTHOR_REGISTRY_URL },
      });
      const refreshed = await refreshStoredLicenseStatuses();
      return reply.send({ registry_url: app.config.AUTHOR_REGISTRY_URL, ...snapshot, refreshed_licenses: refreshed.length });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.get("/platform/author-registry/trust", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAuthorManage(request);
    const result = await getPool().query(
      `select registry_url, root_jwks_json, revocations_json, trust_anchor_json, synced_at, synced_by
         from core.author_registry_snapshots
        where registry_url = $1`,
      [app.config.AUTHOR_REGISTRY_URL],
    );
    if (!result.rowCount) {
      throw new NotFoundError("Author registry trust snapshot not found");
    }
    return reply.send(result.rows[0]);
  });

  app.get("/platform/author-registry/dashboard", async (request, reply) => {
    await requireUserAuth(request, app.config); requireAuthorManage(request);
    return reply.send(await fetchRegistryDashboard(app.config, await registryDelegation(app, request)));
  });
  app.get("/platform/author-registry/authors", async (request, reply) => {
    await requireUserAuth(request, app.config); requireAuthorManage(request);
    return reply.send(await fetchRegistryAuthors(app.config, await registryDelegation(app, request)));
  });
  app.post("/platform/author-registry/authors/:authorId/action", async (request, reply) => {
    await requireUserAuth(request, app.config); requireAuthorManage(request);
    const body = z.object({ action: z.enum(["approve", "suspend", "revoke"]), reason: z.string().max(500).optional() }).parse(request.body);
    const authorId = (request.params as { authorId: string }).authorId;
    return reply.send(await updateRegistryAuthor(app.config, await registryDelegation(app, request), authorId, body.action, body.reason));
  });
  app.get("/platform/author-registry/audit", async (request, reply) => {
    await requireUserAuth(request, app.config); requireAuthorManage(request);
    return reply.send(await fetchRegistryAudit(app.config, await registryDelegation(app, request)));
  });
  app.get("/platform/author-registry/authors/:authorId", async (request, reply) => {
    await requireUserAuth(request, app.config); requireAuthorManage(request);
    const authorId = (request.params as { authorId: string }).authorId;
    return reply.send(await fetchRegistryAuthorDetail(app.config, await registryDelegation(app, request), authorId));
  });
  app.delete("/platform/author-registry/authors/:authorId", async (request, reply) => {
    await requireUserAuth(request, app.config); requireAuthorManage(request);
    const authorId = (request.params as { authorId: string }).authorId;
    return reply.send(await mutateRegistryLifecycle(app.config, await registryDelegation(app, request), `/v1/admin/authors/${encodeURIComponent(authorId)}`, "DELETE"));
  });
  app.post("/platform/author-registry/authors/:authorId/keys/:kid/status", async (request, reply) => {
    await requireUserAuth(request, app.config); requireAuthorManage(request);
    const { authorId, kid } = request.params as { authorId: string; kid: string };
    const body = z.object({ revoke: z.boolean(), reason: z.string().max(500).optional() }).parse(request.body);
    return reply.send(await mutateRegistryLifecycle(app.config, await registryDelegation(app, request), `/v1/admin/authors/${encodeURIComponent(authorId)}/keys/${encodeURIComponent(kid)}/status`, "POST", body));
  });
  app.post("/platform/author-registry/certificates/:id/revoke", async (request, reply) => {
    await requireUserAuth(request, app.config); requireAuthorManage(request);
    const id = (request.params as { id: string }).id;
    const body = z.object({ reason: z.string().min(3).max(500) }).parse(request.body);
    return reply.send(await mutateRegistryLifecycle(app.config, await registryDelegation(app, request), `/v1/admin/certificates/${encodeURIComponent(id)}/revoke`, "POST", body));
  });
}
