import { randomUUID } from "node:crypto";

import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { getPool } from "../src/db/pool.js";

describe("developer connection visibility", () => {
  const suffix = randomUUID().slice(0, 8);
  const tenantId = "tnt_default";
  const ownerId = `usr_connection_owner_${suffix}`;
  const peerId = `usr_connection_peer_${suffix}`;
  const personalId = `dcn_personal_${suffix}`;
  const sharedId = `dcn_shared_${suffix}`;
  const projectId = `local_capabilities_${suffix}`;

  beforeAll(async () => {
    process.env["DATABASE_URL"] ??= "postgres://hc_user:hc_password@localhost:5432/hc_core";
    process.env["JWT_SECRET"] = "supersecretkeysupersecret";
    process.env["JWT_ISSUER"] = "hekatoncheiros-core";
    process.env["JWT_AUDIENCE_USER"] = "hc-user";
    process.env["DEFAULT_TENANT_ID"] = tenantId;
    const pool = getPool();
    await pool.query(
      "insert into core.users(id,email,password_hash,status) values($1,$2,'test','active'),($3,$4,'test','active')",
      [ownerId, `${ownerId}@example.test`, peerId, `${peerId}@example.test`],
    );
    await pool.query(
      "insert into core.user_privileges(user_id,tenant_id,privilege) select user_id,$2,privilege from unnest($1::text[]) user_id cross join unnest($3::text[]) privilege on conflict do nothing",
      [[ownerId, peerId], tenantId, ["developer.connections.use", "developer.projects.read"]],
    );
    await pool.query(
      `insert into core.developer_connections(connection_id,tenant_id,created_by,owner_user_id,visibility,provider,auth_method,owner_label,status)
       values($1,$3,$4,$4,'personal','github','personal_token','Personal','verified'),
             ($2,$3,$4,$4,'tenant','github','personal_token','Shared','verified')`,
      [personalId, sharedId, tenantId, ownerId],
    );
    await pool.query(
      "insert into core.local_app_projects(project_id,tenant_id,created_by,display_name,source_type) values($1,$2,$3,'Capabilities','manifest')",
      [projectId, tenantId, ownerId],
    );
  });

  afterAll(async () => {
    const pool = getPool();
    await pool.query("delete from core.local_app_projects where project_id=$1", [projectId]);
    await pool.query("delete from core.developer_connections where connection_id=any($1::text[])", [
      [personalId, sharedId],
    ]);
    await pool.query("delete from core.users where id=any($1::text[])", [[ownerId, peerId]]);
  });

  async function token(userId: string) {
    return new SignJWT({ tenant_id: tenantId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer("hekatoncheiros-core")
      .setAudience("hc-user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(process.env["JWT_SECRET"]));
  }

  it("shows personal connections only to their owner and exposes real runtime capabilities", async () => {
    const app = await buildApp();
    const ownerResponse = await app.inject({
      method: "GET",
      url: "/api/v1/developer-connections",
      headers: { authorization: `Bearer ${await token(ownerId)}` },
    });
    expect((ownerResponse.json() as { items: Array<{ connection_id: string }> }).items.map((item) => item.connection_id)).toEqual(
      expect.arrayContaining([personalId, sharedId]),
    );

    const peerResponse = await app.inject({
      method: "GET",
      url: "/api/v1/developer-connections",
      headers: { authorization: `Bearer ${await token(peerId)}` },
    });
    expect((peerResponse.json() as { items: Array<{ connection_id: string }> }).items.map((item) => item.connection_id)).toContain(sharedId);
    expect((peerResponse.json() as { items: Array<{ connection_id: string }> }).items.map((item) => item.connection_id)).not.toContain(personalId);

    const capabilities = await app.inject({
      method: "GET",
      url: `/api/v1/developer-projects/${projectId}/runtime-capabilities`,
      headers: { authorization: `Bearer ${await token(ownerId)}` },
    });
    expect(capabilities.json()).toEqual({ supported_actions: [] });
    await app.close();
  });
});
