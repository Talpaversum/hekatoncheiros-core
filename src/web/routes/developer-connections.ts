import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { recordAudit } from "../../audit/audit-service.js";
import { verifyGitHubConnection } from "../../authors/github-provider.js";
import { getPool } from "../../db/pool.js";
import {
  requireConnectionManagement,
  requireConnectionUse,
} from "../../developer/connection-access.js";
import { findAccessibleDeveloperConnection } from "../../developer/connection-access.js";
import {
  decryptDeveloperSecret,
  encryptDeveloperSecret,
} from "../../developer/connection-secret-store.js";
import {
  forgetGitHubInstallationToken,
  getGitHubInstallationToken,
} from "../../developer/github-app-provider.js";
import { createDeveloperSourceProvider } from "../../developer/source-provider-adapter.js";
import { canonicalizeWorkspacePath } from "../../developer/source-providers.js";
import { requireInstanceCapability } from "../../platform/instance-capabilities.js";
import { ForbiddenError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";

const schema = z.object({
  provider: z.enum(["github", "gitlab", "git", "local_workspace", "private_feed"]),
  auth_method: z.enum([
    "github_app",
    "oauth",
    "project_token",
    "personal_token",
    "https_credential",
    "deploy_key",
    "workspace_root",
    "feed_credential",
  ]),
  owner_label: z.string().trim().min(2).max(160),
  scopes: z.array(z.string().max(120)).max(30).default([]),
  credential: z.string().min(1).max(20000).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
const prepare = async (request: FastifyRequest, app: FastifyInstance) => {
  await requireUserAuth(request, app.config);
  requireInstanceCapability(app.config, "privateAppDevelopment");
};
const publicRow = (row: Record<string, unknown>) => ({
  connection_id: row["connection_id"],
  tenant_id: row["tenant_id"],
  provider: row["provider"],
  auth_method: row["auth_method"],
  owner_label: row["owner_label"],
  visibility: row["visibility"],
  owner_user_id: row["owner_user_id"],
  status: row["status"],
  scopes: row["scopes_json"],
  metadata: row["metadata_json"],
  last_used_at: row["last_used_at"],
  last_verified_at: row["last_verified_at"],
  created_at: row["created_at"],
  updated_at: row["updated_at"],
  has_credential: Boolean(row["credential_ciphertext"]),
});
const audit = (request: FastifyRequest, action: string, connectionId: string) =>
  recordAudit({
    tenantId: request.requestContext.tenant.tenantId,
    actorUserId: request.requestContext.actor.userId,
    effectiveUserId: request.requestContext.actor.effectiveUserId,
    action,
    objectRef: connectionId,
    metadata: {},
  });

export async function registerDeveloperConnectionRoutes(app: FastifyInstance) {
  app.get("/developer-connections/:id/repositories", async (request, reply) => {
    await prepare(request, app);
    const id = (request.params as { id: string }).id;
    const connection = await findAccessibleDeveloperConnection(request, id);
    const result = await createDeveloperSourceProvider(connection, app.config).repositories();
    await getPool().query(
      "update core.developer_connections set last_used_at=now() where connection_id=$1",
      [id],
    );
    await audit(request, "developer.connection.repositories.listed", id);
    return reply.send(result);
  });
  app.get("/developer-connections/:id/refs", async (request, reply) => {
    await prepare(request, app);
    const id = (request.params as { id: string }).id;
    const { repository } = z
      .object({ repository: z.string().min(1).max(500) })
      .parse(request.query);
    const connection = await findAccessibleDeveloperConnection(request, id);
    const items = await createDeveloperSourceProvider(connection, app.config).refs(repository);
    await getPool().query(
      "update core.developer_connections set last_used_at=now() where connection_id=$1",
      [id],
    );
    await audit(request, "developer.connection.refs.listed", id);
    return reply.send({ items });
  });
  app.get("/developer-connections", async (request, reply) => {
    await prepare(request, app);
    requireConnectionUse(request);
    const rows = await getPool().query(
      "select * from core.developer_connections where tenant_id=$1 and (visibility='tenant' or owner_user_id=$2) order by updated_at desc",
      [request.requestContext.tenant.tenantId, request.requestContext.actor.userId],
    );
    return reply.send({
      items: rows.rows.map(publicRow),
      workspace_roots: (app.config.DEVELOPER_WORKSPACE_ROOTS ?? "").split(",").filter(Boolean),
    });
  });
  app.post("/developer-connections", async (request, reply) => {
    await prepare(request, app);
    const body = schema.parse(request.body);
    const visibility = z
      .enum(["personal", "tenant"])
      .default("personal")
      .parse((request.body as Record<string, unknown>)["visibility"]);
    const requiredPrivilege =
      visibility === "tenant"
        ? "developer.connections.shared.manage"
        : "developer.connections.personal.manage";
    if (!hasPrivilege(request.requestContext.privileges, requiredPrivilege)) {
      throw new ForbiddenError();
    }
    const id = `dcn_${randomUUID().replaceAll("-", "")}`;
    let metadata = { ...body.metadata };
    let status = "pending";
    if (body.provider === "local_workspace") {
      metadata = {
        ...metadata,
        canonical_path: await canonicalizeWorkspacePath(
          String(body.metadata["path"] ?? ""),
          app.config,
        ),
      };
      status = "verified";
    }
    let secret: { ciphertext: string; iv: string; tag: string } | null = null;
    if (body.credential) secret = encryptDeveloperSecret(body.credential, app.config);
    const result = await getPool().query(
      `insert into core.developer_connections(connection_id,tenant_id,created_by,owner_user_id,visibility,provider,auth_method,owner_label,status,scopes_json,metadata_json,credential_ciphertext,credential_iv,credential_tag,last_verified_at) values($1,$2,$3,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11,$12,$13,case when $8='verified' then now() else null end) returning *`,
      [
        id,
        request.requestContext.tenant.tenantId,
        request.requestContext.actor.userId,
        visibility,
        body.provider,
        body.auth_method,
        body.owner_label,
        status,
        JSON.stringify(body.scopes),
        JSON.stringify(metadata),
        secret?.ciphertext,
        secret?.iv,
        secret?.tag,
      ],
    );
    await audit(request, "developer.connection.created", id);
    return reply.code(201).send(publicRow(result.rows[0]));
  });
  app.post("/developer-connections/:id/verify", async (request, reply) => {
    await prepare(request, app);
    const id = (request.params as { id: string }).id;
    const found = await getPool().query(
      "select * from core.developer_connections where connection_id=$1 and tenant_id=$2 and (visibility='tenant' or owner_user_id=$3)",
      [id, request.requestContext.tenant.tenantId, request.requestContext.actor.userId],
    );
    if (!found.rowCount) throw new NotFoundError("Developer connection not found");
    const row = found.rows[0];
    requireConnectionManagement(request, row);
    let metadata = row.metadata_json as Record<string, unknown>;
    if (row.provider === "local_workspace")
      metadata = {
        ...metadata,
        canonical_path: await canonicalizeWorkspacePath(
          String(metadata["canonical_path"] ?? metadata["path"] ?? ""),
          app.config,
        ),
      };
    if (
      row.provider === "github" &&
      row.auth_method !== "github_app" &&
      row.credential_ciphertext
    ) {
      const token = decryptDeveloperSecret(
        {
          ciphertext: String(row.credential_ciphertext),
          iv: String(row.credential_iv),
          tag: String(row.credential_tag),
        },
        app.config,
      );
      const identity = await verifyGitHubConnection(token);
      metadata = { ...metadata, account_login: identity.login, github_user_id: identity.id };
    }
    if (
      row.provider === "github" &&
      row.auth_method === "github_app" &&
      !metadata["installation_id"]
    )
      throw new Error("GitHub App installation ID is required");
    if (row.provider === "github" && row.auth_method === "github_app") {
      await getGitHubInstallationToken(String(metadata["installation_id"]), app.config);
    }
    const updated = await getPool().query(
      "update core.developer_connections set status='verified',metadata_json=$3::jsonb,last_verified_at=now(),updated_at=now() where connection_id=$1 and tenant_id=$2 returning *",
      [id, request.requestContext.tenant.tenantId, JSON.stringify(metadata)],
    );
    await audit(request, "developer.connection.verified", id);
    return reply.send(publicRow(updated.rows[0]));
  });
  app.delete("/developer-connections/:id", async (request, reply) => {
    await prepare(request, app);
    const id = (request.params as { id: string }).id;
    const found = await getPool().query(
      "select * from core.developer_connections where connection_id=$1 and tenant_id=$2 and (visibility='tenant' or owner_user_id=$3)",
      [id, request.requestContext.tenant.tenantId, request.requestContext.actor.userId],
    );
    if (!found.rowCount) throw new NotFoundError("Developer connection not found");
    requireConnectionManagement(request, found.rows[0]);
    const revoked = found.rows[0];
    if (revoked.provider === "github" && revoked.auth_method === "github_app") {
      const installationId = (revoked.metadata_json as Record<string, unknown>)["installation_id"];
      if (installationId) forgetGitHubInstallationToken(String(installationId));
    }
    await getPool().query(
      "update core.developer_connections set status='revoked',credential_ciphertext=null,credential_iv=null,credential_tag=null,updated_at=now() where connection_id=$1 and tenant_id=$2",
      [id, request.requestContext.tenant.tenantId],
    );
    await audit(request, "developer.connection.revoked", id);
    return reply.code(204).send();
  });
}
