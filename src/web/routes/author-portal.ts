import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { exportJWK, generateKeyPair, type JWK } from "jose";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { validateManifest, type AppManifest } from "../../apps/manifest-validator.js";
import { issueAppUserDelegation } from "../../apps/app-user-delegation.js";
import { recordAudit } from "../../audit/audit-service.js";
import { onboardAuthor, updateRegistryAuthor } from "../../authors/author-registry-client.js";
import { decryptAuthorSecret, encryptAuthorSecret } from "../../authors/author-secret-store.js";
import { listGitHubRepositories, readGitHubFile, verifyGitHubConnection } from "../../authors/github-provider.js";
import {
  AUTHOR_OPERATING_MODES,
  AUTHOR_PERMISSIONS,
  AUTHOR_ROLE_PERMISSIONS,
  assertWorkflowTransition,
  policyForMode,
  type AuthorOperatingMode,
  type AuthorPermission,
  type AuthorRole,
} from "../../authors/author-workflow-policy.js";
import { getPool } from "../../db/pool.js";
import { requireInstanceCapability, resolveInstanceCapabilities } from "../../platform/instance-capabilities.js";
import { ForbiddenError, HttpError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const requestSchema = z.object({
  requested_display_name: z.string().trim().min(2).max(120), legal_name: z.string().trim().max(160).nullable().optional(),
  contact_email: z.string().email(), website: z.string().url().nullable().optional(), git_provider_profile: z.string().trim().max(300).nullable().optional(),
  description: z.string().trim().min(10).max(3000), operating_mode: z.enum(AUTHOR_OPERATING_MODES),
  intended_distribution: z.enum(["official_catalog", "private_catalog", "manual"]), terms_accepted: z.boolean(),
  public_jwks: z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1).max(20) }).nullable().optional(),
  external_issuer_url: z.string().url().nullable().optional(),
});
const connectionSchema = z.object({ author_id: z.string().min(3), token: z.string().min(20) });
const repositorySchema = z.object({ connection_id: z.string().min(3), repository: z.string().min(3), branch: z.string().min(1).max(200), manifest_path: z.string().default("manifest/app-manifest.json") });
const appFromGitSchema = repositorySchema.extend({ author_id: z.string().min(3) });
const memberSchema = z.object({ user_id: z.string().min(1), role: z.enum(["owner", "manager", "developer", "licensing", "viewer"]), permissions: z.array(z.enum(AUTHOR_PERMISSIONS)).optional() });

function isPlatformOperator(request: FastifyRequest) {
  return ["platform.superadmin", "platform.authors.manage", "platform.catalog.manage", "platform.apps.runtime.manage", "platform.author_registry.manage"].some((privilege) => hasPrivilege(request.requestContext.privileges, privilege));
}

function hasPlatformPrivilege(request: FastifyRequest, privilege: string) {
  return hasPrivilege(request.requestContext.privileges, "platform.superadmin") || hasPrivilege(request.requestContext.privileges, privilege);
}

async function requireAuthorPermission(request: FastifyRequest, authorId: string, permission: AuthorPermission) {
  const result = await getPool().query(
    "select permissions_json from core.author_memberships where author_id=$1 and user_id=$2 and status='active'",
    [authorId, request.requestContext.actor.userId],
  );
  const permissions = (result.rows[0]?.permissions_json ?? []) as string[];
  if (!permissions.includes(permission)) throw new HttpError(403, "Author scope is not available to this user", { code: "author_scope_forbidden", author_id: authorId });
}

async function workflowEvent(request: FastifyRequest, input: { authorId?: string; requestId?: string; appId?: string; submissionId?: string; action: string; from?: string; to?: string; metadata?: Record<string, unknown> }) {
  await getPool().query(
    `insert into core.author_workflow_events(author_id,request_id,author_app_id,submission_id,actor_user_id,action,from_status,to_status,metadata_json)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [input.authorId ?? null, input.requestId ?? null, input.appId ?? null, input.submissionId ?? null, request.requestContext.actor.userId, input.action, input.from ?? null, input.to ?? null, JSON.stringify(input.metadata ?? {})],
  );
  await recordAudit({
    tenantId: request.requestContext.tenant.tenantId, actorUserId: request.requestContext.actor.userId,
    effectiveUserId: request.requestContext.actor.effectiveUserId, action: input.action,
    objectRef: input.authorId ?? input.requestId ?? input.appId ?? input.submissionId ?? "author-workflow", metadata: input.metadata ?? {},
  });
}

async function registryDelegation(app: FastifyInstance, request: FastifyRequest) {
  const user = await getPool().query("select email from core.users where id=$1", [request.requestContext.actor.userId]);
  return issueAppUserDelegation({ appId: app.config.AUTHOR_REGISTRY_APP_ID, context: request.requestContext, username: String(user.rows[0]?.email ?? request.requestContext.actor.userId), correlationId: request.id, config: app.config });
}

async function connectionWithToken(app: FastifyInstance, request: FastifyRequest, connectionId: string, permission: AuthorPermission = "author.git.manage") {
  const result = await getPool().query("select * from core.author_git_connections where connection_id=$1 and status='active'", [connectionId]);
  if (!result.rowCount) throw new NotFoundError("Git connection not found");
  const row = result.rows[0];
  await requireAuthorPermission(request, String(row.author_id), permission);
  const token = decryptAuthorSecret({ ciphertext: String(row.credential_ciphertext), iv: String(row.credential_iv), tag: String(row.credential_tag) }, app.config);
  return { row, token };
}

async function inspectRepository(app: FastifyInstance, request: FastifyRequest, input: z.infer<typeof repositorySchema>) {
  const { row, token } = await connectionWithToken(app, request, input.connection_id);
  let manifest: AppManifest | null = null;
  const errors: string[] = [];
  try {
    manifest = JSON.parse(await readGitHubFile(token, input.repository, input.branch, input.manifest_path)) as AppManifest;
    await validateManifest(manifest);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "Manifest validation failed");
  }
  await workflowEvent(request, { authorId: String(row.author_id), action: "author.git.manifest.inspect", metadata: { connection_id: input.connection_id, repository: input.repository, branch: input.branch, manifest_path: input.manifest_path, valid: errors.length === 0 } });
  return { repository: input.repository, branch: input.branch, manifest_path: input.manifest_path, manifest, errors, status: errors.length ? "manifest_invalid" : "ready" };
}

export async function registerAuthorPortalRoutes(app: FastifyInstance) {
  app.get("/author-portal/overview", async (request, reply) => {
    await requireUserAuth(request, app.config);
    const userId = request.requestContext.actor.userId;
    const [requests, profiles, apps, submissions] = await Promise.all([
      getPool().query("select * from core.author_requests where requester_user_id=$1 order by created_at desc", [userId]),
      getPool().query(`select p.*,m.role,m.permissions_json from core.author_memberships m join core.author_profiles p on p.author_id=m.author_id where m.user_id=$1 and m.status='active' order by p.display_name`, [userId]),
      getPool().query(`select a.* from core.author_apps a join core.author_memberships m on m.author_id=a.author_id where m.user_id=$1 and m.status='active' order by a.created_at desc`, [userId]),
      getPool().query(`select s.* from core.catalog_submissions s join core.author_memberships m on m.author_id=s.author_id where m.user_id=$1 and m.status='active' order by s.created_at desc`, [userId]),
    ]);
    return reply.send({
      requests: requests.rows,
      profiles: profiles.rows,
      apps: apps.rows,
      submissions: submissions.rows,
      operating_modes: AUTHOR_OPERATING_MODES.map((mode) => ({ mode, ...policyForMode(mode) })),
      operator: isPlatformOperator(request),
      capabilities: {
        author_review: hasPlatformPrivilege(request, "platform.authors.manage"),
        catalog_review: hasPlatformPrivilege(request, "platform.catalog.manage"),
        runtime_review: hasPlatformPrivilege(request, "platform.apps.runtime.manage"),
        instance: resolveInstanceCapabilities(app.config),
      },
    });
  });

  app.post("/author-portal/requests", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requireInstanceCapability(app.config, "officialAuthorOnboarding");
    const body = requestSchema.parse(request.body);
    const requestId = id("arq");
    const result = await getPool().query(
      `insert into core.author_requests(request_id,requester_user_id,tenant_id,requested_display_name,legal_name,contact_email,website,git_provider_profile,description,operating_mode,intended_distribution,terms_accepted,public_jwks_json,external_issuer_url)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14) returning *`,
      [requestId, request.requestContext.actor.userId, request.requestContext.tenant.tenantId, body.requested_display_name, body.legal_name ?? null, body.contact_email, body.website ?? null, body.git_provider_profile ?? null, body.description, body.operating_mode, body.intended_distribution, body.terms_accepted, body.public_jwks ? JSON.stringify(body.public_jwks) : null, body.external_issuer_url ?? null],
    );
    await workflowEvent(request, { requestId, action: "author.request.created", to: "draft", metadata: { operating_mode: body.operating_mode } });
    return reply.code(201).send(result.rows[0]);
  });

  app.put("/author-portal/requests/:id", async (request, reply) => {
    await requireUserAuth(request, app.config); requireInstanceCapability(app.config, "officialAuthorOnboarding"); const body = requestSchema.parse(request.body); const requestId = (request.params as { id: string }).id;
    const result = await getPool().query(
      `update core.author_requests set requested_display_name=$3,legal_name=$4,contact_email=$5,website=$6,git_provider_profile=$7,description=$8,operating_mode=$9,intended_distribution=$10,terms_accepted=$11,public_jwks_json=$12::jsonb,external_issuer_url=$13,updated_at=now()
       where request_id=$1 and requester_user_id=$2 and status in ('draft','needs_changes','rejected') returning *`,
      [requestId, request.requestContext.actor.userId, body.requested_display_name, body.legal_name ?? null, body.contact_email, body.website ?? null, body.git_provider_profile ?? null, body.description, body.operating_mode, body.intended_distribution, body.terms_accepted, body.public_jwks ? JSON.stringify(body.public_jwks) : null, body.external_issuer_url ?? null],
    );
    if (!result.rowCount) throw new NotFoundError("Editable author request not found");
    await workflowEvent(request, { requestId, action: "author.request.updated", metadata: { operating_mode: body.operating_mode } }); return reply.send(result.rows[0]);
  });

  app.post("/author-portal/requests/:id/submit", async (request, reply) => {
    await requireUserAuth(request, app.config); requireInstanceCapability(app.config, "officialAuthorOnboarding"); const requestId = (request.params as { id: string }).id;
    const current = await getPool().query("select * from core.author_requests where request_id=$1 and requester_user_id=$2", [requestId, request.requestContext.actor.userId]);
    if (!current.rowCount) throw new NotFoundError("Author request not found");
    const row = current.rows[0];
    if (row.operating_mode === "private_self_hosted") throw new HttpError(409, "Private self-hosted development does not require an official author request");
    if (!row.terms_accepted) throw new HttpError(400, "Terms must be accepted before submission");
    assertWorkflowTransition("request", String(row.status), "submitted");
    const result = await getPool().query("update core.author_requests set status='submitted',submitted_at=now(),updated_at=now() where request_id=$1 returning *", [requestId]);
    await workflowEvent(request, { requestId, action: "author.request.submitted", from: String(row.status), to: "submitted" }); return reply.send(result.rows[0]);
  });

  app.get("/author-portal/admin/requests", async (request, reply) => {
    await requireUserAuth(request, app.config); requireInstanceCapability(app.config, "officialAuthorRegistry"); if (!hasPlatformPrivilege(request, "platform.authors.manage")) throw new ForbiddenError();
    return reply.send({ items: (await getPool().query("select * from core.author_requests order by created_at desc")).rows });
  });

  app.post("/author-portal/admin/requests/:id/action", async (request, reply) => {
    await requireUserAuth(request, app.config); requireInstanceCapability(app.config, "officialAuthorRegistry"); if (!hasPlatformPrivilege(request, "platform.authors.manage")) throw new ForbiddenError();
    const requestId = (request.params as { id: string }).id;
    const body = z.object({ action: z.enum(["start_review", "request_changes", "approve", "reject", "suspend", "revoke"]), notes: z.string().max(3000).optional() }).parse(request.body);
    const found = await getPool().query("select * from core.author_requests where request_id=$1", [requestId]); if (!found.rowCount) throw new NotFoundError("Author request not found");
    const row = found.rows[0] as Record<string, unknown>; const from = String(row["status"]);
    const target = { start_review: "pending_review", request_changes: "needs_changes", approve: "approved", reject: "rejected", suspend: "suspended", revoke: "revoked" }[body.action];
    assertWorkflowTransition("request", from, target);
    let authorId = typeof row["author_id"] === "string" ? row["author_id"] : null;
    if (body.action === "approve" && !authorId) {
      const mode = row["operating_mode"] as AuthorOperatingMode;
      if (mode === "private_self_hosted") throw new HttpError(409, "Private self-hosted mode is local and cannot be approved into the official Registry");
      let publicJwks = row["public_jwks_json"] as { keys: Array<Record<string, unknown>> } | null;
      let privateJwk: JWK | null = null;
      if (mode === "talpaversum_hosted") {
        const pair = await generateKeyPair("EdDSA", { extractable: true }); const kid = `author-${randomUUID()}`;
        publicJwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid, alg: "EdDSA", use: "sig" } as Record<string, unknown>] };
        privateJwk = { ...(await exportJWK(pair.privateKey)), kid, alg: "EdDSA", use: "sig" };
      }
      if (!publicJwks?.keys?.length) throw new HttpError(400, "Trusted self-hosted approval requires author public JWKS");
      const issued = await onboardAuthor({ config: app.config, displayName: String(row["requested_display_name"]), operatingMode: mode, jwks: publicJwks, ttlDays: 365, delegatedUserToken: await registryDelegation(app, request) });
      authorId = issued.author_id;
      const client = await getPool().connect();
      try {
        await client.query("begin");
        await client.query(`insert into core.author_profiles(author_id,display_name,legal_name,contact_email,website,description,operating_mode,owner_tenant_id,registry_status,author_cert_jws,public_jwks_json,external_issuer_url,created_from_request_id) values($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10::jsonb,$11,$12)`, [authorId, row["requested_display_name"], row["legal_name"], row["contact_email"], row["website"], row["description"], mode, row["tenant_id"], issued.author_cert_jws, JSON.stringify(publicJwks), row["external_issuer_url"], requestId]);
        await client.query(`insert into core.author_memberships(author_id,user_id,role,permissions_json,created_by) values($1,$2,'owner',$3::jsonb,$4)`, [authorId, row["requester_user_id"], JSON.stringify(AUTHOR_ROLE_PERMISSIONS.owner), request.requestContext.actor.userId]);
        await client.query(`insert into core.author_onboardings(author_id,display_name,public_jwks_json,author_cert_jws,root_kid,registry_url,created_by) values($1,$2,$3::jsonb,$4,$5,$6,$7)`, [authorId, row["requested_display_name"], JSON.stringify(publicJwks), issued.author_cert_jws, issued.root_kid, app.config.AUTHOR_REGISTRY_URL, request.requestContext.actor.userId]);
        if (privateJwk) {
          const encrypted = encryptAuthorSecret(JSON.stringify(privateJwk), app.config);
          await client.query(`insert into core.author_signing_keys(key_id,author_id,public_jwk_json,private_jwk_ciphertext,private_jwk_iv,private_jwk_tag,custody) values($1,$2,$3::jsonb,$4,$5,$6,'talpaversum_managed')`, [String(privateJwk.kid), authorId, JSON.stringify(publicJwks.keys[0]), encrypted.ciphertext, encrypted.iv, encrypted.tag]);
        } else {
          for (const key of publicJwks.keys) await client.query(`insert into core.author_signing_keys(key_id,author_id,public_jwk_json,custody) values($1,$2,$3::jsonb,'author_managed')`, [String(key["kid"]), authorId, JSON.stringify(key)]);
        }
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; } finally { client.release(); }
    }
    if (authorId && ["approve", "suspend", "revoke"].includes(body.action) && !(body.action === "approve" && from === "pending_review")) {
      await updateRegistryAuthor(app.config, await registryDelegation(app, request), authorId, body.action as "approve" | "suspend" | "revoke", body.notes);
      const profileStatus = body.action === "approve" ? "active" : body.action === "suspend" ? "suspended" : "revoked";
      await getPool().query("update core.author_profiles set status=$2,registry_status=$2,updated_at=now() where author_id=$1", [authorId, profileStatus]);
    }
    const result = await getPool().query("update core.author_requests set status=$2,review_notes=$3,reviewed_at=now(),reviewed_by=$4,author_id=coalesce($5,author_id),updated_at=now() where request_id=$1 returning *", [requestId, target, body.notes ?? null, request.requestContext.actor.userId, authorId]);
    await workflowEvent(request, { requestId, authorId: authorId ?? undefined, action: `author.request.${body.action}`, from, to: target, metadata: { notes: body.notes } }); return reply.send(result.rows[0]);
  });

  app.get("/author-portal/profiles", async (request, reply) => {
    await requireUserAuth(request, app.config);
    const result = await getPool().query(`select p.*,m.role,m.permissions_json from core.author_memberships m join core.author_profiles p on p.author_id=m.author_id where m.user_id=$1 and m.status='active' order by p.display_name`, [request.requestContext.actor.userId]);
    return reply.send({ items: result.rows });
  });

  app.put("/author-portal/profiles/:id", async (request, reply) => {
    await requireUserAuth(request, app.config); const authorId = (request.params as { id: string }).id; await requireAuthorPermission(request, authorId, "author.profile.manage");
    const body = z.object({ display_name: z.string().trim().min(2).max(120), legal_name: z.string().trim().max(160).nullable().optional(), contact_email: z.string().email(), website: z.string().url().nullable().optional(), description: z.string().trim().max(3000) }).parse(request.body);
    const result = await getPool().query("update core.author_profiles set display_name=$2,legal_name=$3,contact_email=$4,website=$5,description=$6,updated_at=now() where author_id=$1 returning *", [authorId, body.display_name, body.legal_name ?? null, body.contact_email, body.website ?? null, body.description]);
    if (!result.rowCount) throw new NotFoundError("Author profile not found"); await workflowEvent(request, { authorId, action: "author.profile.updated" }); return reply.send(result.rows[0]);
  });

  app.get("/author-portal/profiles/:id/members", async (request, reply) => {
    await requireUserAuth(request, app.config); const authorId = (request.params as { id: string }).id; await requireAuthorPermission(request, authorId, "author.members.manage");
    return reply.send({ items: (await getPool().query(`select m.author_id,m.user_id,m.role,m.permissions_json,m.status,m.created_at,u.email from core.author_memberships m join core.users u on u.id=m.user_id where m.author_id=$1 order by u.email`, [authorId])).rows });
  });

  app.put("/author-portal/profiles/:id/members", async (request, reply) => {
    await requireUserAuth(request, app.config); const authorId = (request.params as { id: string }).id; await requireAuthorPermission(request, authorId, "author.members.manage"); const body = memberSchema.parse(request.body);
    const permissions = body.permissions ?? AUTHOR_ROLE_PERMISSIONS[body.role as AuthorRole];
    const result = await getPool().query(`insert into core.author_memberships(author_id,user_id,role,permissions_json,created_by) values($1,$2,$3,$4::jsonb,$5) on conflict(author_id,user_id) do update set role=excluded.role,permissions_json=excluded.permissions_json,status='active',updated_at=now() returning *`, [authorId, body.user_id, body.role, JSON.stringify(permissions), request.requestContext.actor.userId]);
    await workflowEvent(request, { authorId, action: "author.membership.saved", metadata: { user_id: body.user_id, role: body.role } }); return reply.send(result.rows[0]);
  });

  app.get("/author-portal/git-connections", async (request, reply) => {
    await requireUserAuth(request, app.config);
    const authorId = z.string().optional().parse((request.query as { author_id?: string }).author_id); if (authorId) await requireAuthorPermission(request, authorId, "author.audit.read");
    const result = await getPool().query(`select c.connection_id,c.author_id,c.provider,c.account_login,c.status,c.metadata_json,c.last_verified_at,c.created_at from core.author_git_connections c join core.author_memberships m on m.author_id=c.author_id where m.user_id=$1 and m.status='active' and ($2::text is null or c.author_id=$2) order by c.created_at desc`, [request.requestContext.actor.userId, authorId ?? null]);
    return reply.send({ items: result.rows });
  });

  app.post("/author-portal/git-connections/github", async (request, reply) => {
    await requireUserAuth(request, app.config); const body = connectionSchema.parse(request.body); await requireAuthorPermission(request, body.author_id, "author.git.manage");
    const identity = await verifyGitHubConnection(body.token); const encrypted = encryptAuthorSecret(body.token, app.config); const connectionId = id("git");
    const result = await getPool().query(`insert into core.author_git_connections(connection_id,author_id,provider,account_login,credential_ciphertext,credential_iv,credential_tag,metadata_json,last_verified_at,created_by) values($1,$2,'github',$3,$4,$5,$6,$7::jsonb,now(),$8) on conflict(author_id,provider,account_login) do update set credential_ciphertext=excluded.credential_ciphertext,credential_iv=excluded.credential_iv,credential_tag=excluded.credential_tag,status='active',last_verified_at=now(),updated_at=now() returning connection_id,author_id,provider,account_login,status,metadata_json,last_verified_at,created_at`, [connectionId, body.author_id, identity.login, encrypted.ciphertext, encrypted.iv, encrypted.tag, JSON.stringify({ github_user_id: identity.id, avatar_url: identity.avatar_url }), request.requestContext.actor.userId]);
    await workflowEvent(request, { authorId: body.author_id, action: "author.git.connected", metadata: { provider: "github", account_login: identity.login } }); return reply.code(201).send(result.rows[0]);
  });

  app.delete("/author-portal/git-connections/:id", async (request, reply) => {
    await requireUserAuth(request, app.config); const connectionId = (request.params as { id: string }).id; const found = await getPool().query("select author_id from core.author_git_connections where connection_id=$1", [connectionId]); if (!found.rowCount) throw new NotFoundError("Git connection not found"); const authorId = String(found.rows[0].author_id); await requireAuthorPermission(request, authorId, "author.git.manage");
    await getPool().query("update core.author_git_connections set status='revoked',credential_ciphertext='',credential_iv='',credential_tag='',updated_at=now() where connection_id=$1", [connectionId]); await workflowEvent(request, { authorId, action: "author.git.disconnected", metadata: { connection_id: connectionId } }); return reply.code(204).send();
  });

  app.get("/author-portal/git-connections/:id/repositories", async (request, reply) => {
    await requireUserAuth(request, app.config); const connectionId = (request.params as { id: string }).id; const { row, token } = await connectionWithToken(app, request, connectionId); const repositories = await listGitHubRepositories(token);
    await workflowEvent(request, { authorId: String(row.author_id), action: "author.git.repositories.read", metadata: { connection_id: connectionId, count: repositories.length } });
    return reply.send({ items: repositories.map((repo) => ({ ...repo, visibility: repo.private ? "private" : "public", accessible: true })) });
  });

  app.post("/author-portal/repositories/inspect", async (request, reply) => { await requireUserAuth(request, app.config); return reply.send(await inspectRepository(app, request, repositorySchema.parse(request.body))); });

  app.get("/author-portal/apps", async (request, reply) => {
    await requireUserAuth(request, app.config);
    const query = z.object({ scope: z.enum(["workspace", "registry"]).optional(), author_id: z.string().optional() }).parse(request.query);
    const operator = query.scope === "registry" && (hasPlatformPrivilege(request, "platform.catalog.manage") || hasPlatformPrivilege(request, "platform.apps.runtime.manage"));
    if (query.scope === "registry") requireInstanceCapability(app.config, "officialAuthorRegistry");
    if (query.scope === "registry" && !operator) throw new ForbiddenError();
    if (query.author_id) await requireAuthorPermission(request, query.author_id, "author.audit.read");
    const result = operator
      ? await getPool().query(`select a.*,p.operating_mode,coalesce(m.permissions_json,'[]'::jsonb) as member_permissions_json from core.author_apps a join core.author_profiles p on p.author_id=a.author_id left join core.author_memberships m on m.author_id=a.author_id and m.user_id=$1 and m.status='active' order by a.created_at desc`, [request.requestContext.actor.userId])
      : await getPool().query(`select a.*,p.operating_mode,m.permissions_json as member_permissions_json from core.author_apps a join core.author_profiles p on p.author_id=a.author_id join core.author_memberships m on m.author_id=a.author_id where m.user_id=$1 and m.status='active' and ($2::text is null or a.author_id=$2) order by a.created_at desc`, [request.requestContext.actor.userId, query.author_id ?? null]);
    return reply.send({ items: result.rows });
  });

  app.post("/author-portal/apps/from-git", async (request, reply) => {
    await requireUserAuth(request, app.config); const body = appFromGitSchema.parse(request.body); await requireAuthorPermission(request, body.author_id, "author.apps.create");
    const profile = await getPool().query("select operating_mode,external_issuer_url from core.author_profiles where author_id=$1 and status='active'", [body.author_id]); if (!profile.rowCount) throw new NotFoundError("Author profile not found");
    const inspected = await inspectRepository(app, request, body); const manifest = inspected.manifest; const appId = typeof manifest?.["app_id"] === "string" ? manifest["app_id"] : null;
    const errors = [...inspected.errors]; if (appId && !appId.startsWith(`${body.author_id}/`)) errors.push("Manifest app_id must use the approved author_id namespace");
    const mode = profile.rows[0].operating_mode as AuthorOperatingMode; const policy = policyForMode(mode); const authorAppId = id("aap");
    const displayName = typeof manifest?.["app_name"] === "string" ? manifest["app_name"] : body.repository.split("/").at(-1) ?? "Application";
    const integration = manifest?.["integration"] as Record<string, unknown> | undefined; const licensing = manifest?.["licensing"] as Record<string, unknown> | undefined;
    const result = await getPool().query(`insert into core.author_apps(author_app_id,author_id,app_id,display_name,integration_slug,git_connection_id,repository_full_name,repository_visibility,branch,manifest_path,manifest_json,manifest_errors_json,status,runtime_management,licensing_management,issuer_url,created_by) values($1,$2,$3,$4,$5,$6,$7,'unknown',$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16) returning *`, [authorAppId, body.author_id, appId, displayName, typeof integration?.["slug"] === "string" ? integration["slug"] : null, body.connection_id, body.repository, body.branch, body.manifest_path, manifest ? JSON.stringify(manifest) : null, JSON.stringify(errors), errors.length ? "manifest_invalid" : "ready_for_review", policy.runtimeManagement, policy.licensingManagement, typeof licensing?.["issuer_url"] === "string" ? licensing["issuer_url"] : profile.rows[0].external_issuer_url, request.requestContext.actor.userId]);
    await workflowEvent(request, { authorId: body.author_id, appId: authorAppId, action: "author.app.created_from_git", to: String(result.rows[0].status), metadata: { repository: body.repository, valid: errors.length === 0 } }); return reply.code(201).send(result.rows[0]);
  });

  app.post("/author-portal/apps/:id/action", async (request, reply) => {
    await requireUserAuth(request, app.config); const authorAppId = (request.params as { id: string }).id; const body = z.object({ action: z.enum(["submit", "approve", "reject", "request_runtime", "approve_runtime", "mark_running", "disable"]), notes: z.string().max(3000).optional() }).parse(request.body);
    const found = await getPool().query(`select a.*,p.operating_mode from core.author_apps a join core.author_profiles p on p.author_id=a.author_id where a.author_app_id=$1`, [authorAppId]); if (!found.rowCount) throw new NotFoundError("Author application not found"); const row = found.rows[0]; const from = String(row.status);
    const catalogAction = ["approve", "reject"].includes(body.action);
    const runtimeAction = ["approve_runtime", "mark_running", "disable"].includes(body.action);
    if (catalogAction) requireInstanceCapability(app.config, "officialCatalogReview");
    if (body.action === "request_runtime" || runtimeAction) requireInstanceCapability(app.config, "hostedRuntime");
    if (catalogAction && !hasPlatformPrivilege(request, "platform.catalog.manage")) throw new ForbiddenError();
    if (runtimeAction && !hasPlatformPrivilege(request, "platform.apps.runtime.manage")) throw new ForbiddenError();
    if (!catalogAction && !runtimeAction) await requireAuthorPermission(request, String(row.author_id), "author.apps.submit");
    const target = { submit: "submitted", approve: "approved", reject: "rejected", request_runtime: "runtime_pending", approve_runtime: "runtime_approved", mark_running: "running", disable: "disabled" }[body.action];
    if (body.action === "request_runtime" && row.operating_mode !== "talpaversum_hosted") throw new HttpError(409, "Only Talpaversum-hosted applications can request Talpaversum runtime approval");
    assertWorkflowTransition("app", from, target); const result = await getPool().query("update core.author_apps set status=$2,review_notes=$3,updated_at=now() where author_app_id=$1 returning *", [authorAppId, target, body.notes ?? null]); await workflowEvent(request, { authorId: String(row.author_id), appId: authorAppId, action: `author.app.${body.action}`, from, to: target, metadata: { notes: body.notes } }); return reply.send(result.rows[0]);
  });

  app.post("/author-portal/apps/:id/catalog-submission", async (request, reply) => {
    await requireUserAuth(request, app.config); requireInstanceCapability(app.config, "officialCatalogPublishing"); const authorAppId = (request.params as { id: string }).id; const found = await getPool().query(`select a.*,p.operating_mode,p.registry_status from core.author_apps a join core.author_profiles p on p.author_id=a.author_id where a.author_app_id=$1`, [authorAppId]); if (!found.rowCount) throw new NotFoundError("Author application not found"); const row = found.rows[0]; await requireAuthorPermission(request, String(row.author_id), "author.apps.publish");
    const policy = policyForMode(row.operating_mode as AuthorOperatingMode); const eligibility = { official_catalog_eligible: policy.officialCatalogEligible, registry_active: row.registry_status === "active", manifest_valid: (row.manifest_errors_json as unknown[]).length === 0, app_approved: ["approved", "runtime_approved", "running", "published"].includes(String(row.status)) };
    if (!Object.values(eligibility).every(Boolean)) throw new HttpError(409, "Application is not eligible for official catalog submission", eligibility);
    const submissionId = id("sub"); const result = await getPool().query(`insert into core.catalog_submissions(submission_id,author_app_id,author_id,status,eligibility_json,submitted_by,submitted_at) values($1,$2,$3,'submitted',$4::jsonb,$5,now()) returning *`, [submissionId, authorAppId, row.author_id, JSON.stringify(eligibility), request.requestContext.actor.userId]); await workflowEvent(request, { authorId: String(row.author_id), appId: authorAppId, submissionId, action: "author.catalog.submitted", to: "submitted", metadata: eligibility }); return reply.code(201).send(result.rows[0]);
  });

  app.get("/author-portal/catalog-submissions", async (request, reply) => {
    await requireUserAuth(request, app.config); const query = z.object({ scope: z.enum(["workspace", "registry"]).optional(), author_id: z.string().optional() }).parse(request.query); const operator = query.scope === "registry" && hasPlatformPrivilege(request, "platform.catalog.manage"); if (query.scope === "registry") requireInstanceCapability(app.config, "officialCatalogReview"); if (query.scope === "registry" && !operator) throw new ForbiddenError(); if (query.author_id) await requireAuthorPermission(request, query.author_id, "author.apps.read"); const result = operator ? await getPool().query(`select s.*,a.display_name,a.app_id,p.operating_mode from core.catalog_submissions s join core.author_apps a on a.author_app_id=s.author_app_id join core.author_profiles p on p.author_id=s.author_id order by s.created_at desc`) : await getPool().query(`select s.*,a.display_name,a.app_id,p.operating_mode from core.catalog_submissions s join core.author_apps a on a.author_app_id=s.author_app_id join core.author_profiles p on p.author_id=s.author_id join core.author_memberships m on m.author_id=s.author_id where m.user_id=$1 and m.status='active' and ($2::text is null or s.author_id=$2) order by s.created_at desc`, [request.requestContext.actor.userId, query.author_id ?? null]); return reply.send({ items: result.rows, operator });
  });

  app.post("/author-portal/admin/catalog-submissions/:id/action", async (request, reply) => {
    await requireUserAuth(request, app.config); requireInstanceCapability(app.config, "officialCatalogReview"); if (!hasPlatformPrivilege(request, "platform.catalog.manage")) throw new ForbiddenError(); const submissionId = (request.params as { id: string }).id; const body = z.object({ action: z.enum(["start_review", "request_changes", "approve", "reject", "publish", "unpublish"]), notes: z.string().max(3000).optional() }).parse(request.body); const found = await getPool().query("select * from core.catalog_submissions where submission_id=$1", [submissionId]); if (!found.rowCount) throw new NotFoundError("Catalog submission not found"); const row = found.rows[0]; const from = String(row.status); const target = { start_review: "pending_review", request_changes: "needs_changes", approve: "approved", reject: "rejected", publish: "published", unpublish: "unpublished" }[body.action]; assertWorkflowTransition("submission", from, target);
    const result = await getPool().query("update core.catalog_submissions set status=$2,review_notes=$3,reviewed_by=$4,reviewed_at=now(),published_at=case when $2='published' then now() else published_at end,updated_at=now() where submission_id=$1 returning *", [submissionId, target, body.notes ?? null, request.requestContext.actor.userId]); if (target === "published") await getPool().query("update core.author_apps set status='published',updated_at=now() where author_app_id=$1", [row.author_app_id]); await workflowEvent(request, { authorId: String(row.author_id), appId: String(row.author_app_id), submissionId, action: `author.catalog.${body.action}`, from, to: target, metadata: { notes: body.notes } }); return reply.send(result.rows[0]);
  });

  app.get("/author-portal/activity", async (request, reply) => {
    await requireUserAuth(request, app.config); const authorId = z.string().optional().parse((request.query as { author_id?: string }).author_id); if (authorId) await requireAuthorPermission(request, authorId, "author.audit.read"); const result = authorId ? await getPool().query("select * from core.author_workflow_events where author_id=$1 order by created_at desc limit 300", [authorId]) : await getPool().query(`select e.* from core.author_workflow_events e left join core.author_memberships m on m.author_id=e.author_id and m.user_id=$1 where e.actor_user_id=$1 or m.user_id=$1 order by e.created_at desc limit 300`, [request.requestContext.actor.userId]); return reply.send({ items: result.rows });
  });
}
