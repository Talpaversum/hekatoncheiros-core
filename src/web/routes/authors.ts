import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { recordAudit } from "../../audit/audit-service.js";
import {
  fetchAuthorRegistryTrust,
  onboardAuthor,
  rotateAuthorKeys,
} from "../../authors/author-registry-client.js";
import { getPool } from "../../db/pool.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

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
        jwks: parsed.jwks,
        ttlDays: parsed.cert_ttl_days,
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
         ) values ($1, $2::jsonb, $3::jsonb, now(), $4)
         on conflict (registry_url) do update set
           root_jwks_json = excluded.root_jwks_json,
           revocations_json = excluded.revocations_json,
           synced_at = now(), synced_by = excluded.synced_by`,
        [
          app.config.AUTHOR_REGISTRY_URL,
          JSON.stringify(snapshot.rootJwks),
          JSON.stringify(snapshot.revocations),
          request.requestContext.actor.userId,
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
      return reply.send({ registry_url: app.config.AUTHOR_REGISTRY_URL, ...snapshot });
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }
  });

  app.get("/platform/author-registry/trust", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireAuthorManage(request);
    const result = await getPool().query(
      `select registry_url, root_jwks_json, revocations_json, synced_at, synced_by
         from core.author_registry_snapshots
        where registry_url = $1`,
      [app.config.AUTHOR_REGISTRY_URL],
    );
    if (!result.rowCount) {
      throw new NotFoundError("Author registry trust snapshot not found");
    }
    return reply.send(result.rows[0]);
  });
}
