import { randomUUID } from "node:crypto";

import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { getPool } from "../src/db/pool.js";

describe("developer project and log tenant isolation", () => {
  const suffix = randomUUID().slice(0, 8);
  const tenantA = "tnt_default";
  const tenantB = `tnt_isolation_${suffix}`;
  const userA = `usr_isolation_a_${suffix}`;
  const userB = `usr_isolation_b_${suffix}`;
  const projectA = `local_isolation_a_${suffix}`;
  const projectB = `local_isolation_b_${suffix}`;
  const deploymentB = `dep_isolation_b_${suffix}`;

  beforeAll(() => {
    process.env["NODE_ENV"] = "test";
    process.env["DATABASE_URL"] ??= "postgres://hc_user:hc_password@localhost:5432/hc_core";
    process.env["JWT_SECRET"] = "supersecretkeysupersecret";
    process.env["INSTALLER_TOKEN_SECRET"] = "installersecretinstallersecret";
  });

  afterAll(async () => {
    await getPool().query("delete from core.local_app_projects where project_id=any($1::text[])", [
      [projectA, projectB],
    ]);
    await getPool().query("delete from core.user_privileges where user_id=any($1::text[])", [
      [userA, userB],
    ]);
    await getPool().query("delete from core.users where id=any($1::text[])", [[userA, userB]]);
    await getPool().query("delete from core.tenants where id=$1", [tenantB]);
  });

  it("does not expose projects, deployments, or logs across tenants", async () => {
    const pool = getPool();
    await pool.query(
      "insert into core.tenants(id,name,status) values($1,'Isolation tenant','active')",
      [tenantB],
    );
    for (const [user, tenant] of [
      [userA, tenantA],
      [userB, tenantB],
    ]) {
      await pool.query(
        "insert into core.users(id,email,password_hash,status) values($1,$2,'test-only','active')",
        [user, `${user}@example.test`],
      );
      await pool.query(
        "insert into core.user_privileges(user_id,tenant_id,privilege) select $1,$2,unnest($3::text[])",
        [user, tenant, ["developer.projects.read", "developer.logs.read"]],
      );
    }
    await pool.query(
      "insert into core.local_app_projects(project_id,tenant_id,created_by,display_name,source_type) values($1,$2,$3,'Tenant A project','manifest'),($4,$5,$6,'Tenant B project','manifest')",
      [projectA, tenantA, userA, projectB, tenantB, userB],
    );
    await pool.query(
      "insert into core.developer_deployments(deployment_id,tenant_id,project_id,status,started_by) values($1,$2,$3,'failed',$4)",
      [deploymentB, tenantB, projectB, userB],
    );
    await pool.query(
      "insert into core.developer_logs(tenant_id,project_id,deployment_id,category,level,message) values($1,$2,$3,'deployment','error','Tenant B private log')",
      [tenantB, projectB, deploymentB],
    );
    const app = await buildApp();
    const token = async (user: string, tenant: string) =>
      new SignJWT({ tenant_id: tenant })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user)
        .setIssuer("hekatoncheiros-core")
        .setAudience("hc-user")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode(process.env["JWT_SECRET"]));
    const request = async (user: string, tenant: string, path: string) =>
      app.inject({
        method: "GET",
        url: `/api/v1${path}`,
        headers: { authorization: `Bearer ${await token(user, tenant)}` },
      });
    const projectsForA = (await request(userA, tenantA, "/developer-projects")).json()
      .items as Array<{ project_id: string }>;
    expect(projectsForA.map((item) => item.project_id)).toContain(projectA);
    expect(projectsForA.map((item) => item.project_id)).not.toContain(projectB);
    expect(
      (await request(userA, tenantA, `/developer-deployments/${deploymentB}`)).statusCode,
    ).toBe(404);
    expect(
      (await request(userA, tenantA, `/developer-logs?project_id=${projectB}`)).json().items,
    ).toEqual([]);
    const logsForB = (
      await request(userB, tenantB, `/developer-logs?project_id=${projectB}`)
    ).json().items as Array<{ message: string }>;
    expect(logsForB).toContainEqual(expect.objectContaining({ message: "Tenant B private log" }));
    await app.close();
  });
});
