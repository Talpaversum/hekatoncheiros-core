import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { getPool } from "../src/db/pool.js";

describe("private developer project workflow", () => {
  const tenantId = "tnt_default";
  let server: Server;
  let origin = "";
  const suffix = randomUUID().slice(0, 8);
  const userId = `usr_dev_${suffix}`;
  const appId = `local-test/${suffix}`;
  const slug = `local-test-${suffix}`;

  beforeAll(async () => {
    process.env["NODE_ENV"] = "test";
    process.env["DATABASE_URL"] = process.env["DATABASE_URL"] ?? "postgres://hc_user:hc_password@localhost:5432/hc_core";
    process.env["JWT_SECRET"] = "supersecretkeysupersecret";
    process.env["JWT_ISSUER"] = "hekatoncheiros-core";
    process.env["JWT_AUDIENCE_USER"] = "hc-user";
    process.env["JWT_AUDIENCE_APP"] = "hc-app";
    process.env["INSTALLER_TOKEN_SECRET"] = "installersecretinstallersecret";
    process.env["INSTALLER_TOKEN_ISSUER"] = "hekatoncheiros-core-installer";
    process.env["DEFAULT_TENANT_ID"] = tenantId;

    server = createServer((request, response) => {
      if (request.method === "HEAD" && request.url === "/") { response.writeHead(200).end(); return; }
      if (request.method === "GET" && request.url === "/manifest.json") {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({
          app_id: appId, app_name: "Local Test App", version: "1.0.0", vendor: { name: "Local developer" },
          tenancy: { scope: "tenant", cross_tenant_collaboration: { supported: false, shareables: [] } },
          data: { schemas: ["local_test"], no_cross_app_access: true },
          privileges: { required: [], optional: [] },
          licensing: { required: false, enforced_by_app: true, offline_supported: false, modes: ["perpetual"], expiry_behavior: { non_destructive: true, read_only: false, api_read_only: false } },
          localization: { contract_version: 1, default_locale: "en", supported_locales: ["en"], resources: [{ locale: "en", path: "locales/en.json", format: "hc-flat-json-v1" }] },
          integration: { slug, api: { exposes: { base_path: `/apps/${slug}`, version: "v1" }, consumes_core_api: true }, events: { emits: [], consumes: [], idempotent_consumers: true }, ui: { artifact: { url: `${origin}/ui/plugin.js`, auth: "core-signed-token" }, nav_entries: [{ label: "Overview", path: `/app/${slug}`, required_privileges: [`${appId}.read`] }] } },
        })); return;
      }
      if (request.method === "GET" && request.url === "/ui/plugin.js") {
        if (!request.headers.authorization) { response.writeHead(401).end(); return; }
        response.setHeader("content-type", "application/javascript"); response.end("export default function mount() {}\n"); return;
      }
      if (request.method === "GET" && request.url === "/health") { response.setHeader("content-type", "application/json"); response.end('{"status":"healthy"}'); return; }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Test application did not bind a TCP port");
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await getPool().query("delete from core.local_app_projects where installed_app_id=$1 or origin_url=$2", [appId, origin]);
    await getPool().query("delete from core.installed_apps where app_id=$1", [appId]);
    await getPool().query("delete from core.trusted_origins where origin=$1", [origin]);
    await getPool().query("delete from core.user_privileges where user_id=$1 and privilege like 'developer.%'", [userId]);
    await getPool().query("delete from core.users where id=$1", [userId]);
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("installs a local unverified app without an author identity", async () => {
    const app = await buildApp();
    await getPool().query("insert into core.users(id,email,password_hash,status) values($1,$2,'test-only','active') on conflict(id) do nothing", [userId, `${userId}@example.test`]);
    await getPool().query("insert into core.user_privileges(user_id,tenant_id,privilege) select $1,$2,unnest($3::text[]) on conflict do nothing", [userId, tenantId, ["developer.projects.read", "developer.projects.create", "developer.projects.manage", "developer.deployments.run", "developer.logs.read"]]);
    const token = await new SignJWT({ tenant_id: tenantId }).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuer("hekatoncheiros-core").setAudience("hc-user").setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(process.env["JWT_SECRET"]));
    const request = async (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url: `/api/v1${url}`, headers: { authorization: `Bearer ${token}` }, payload });

    const draft = await request("POST", "/developer-projects/drafts", { display_name: "Local Test Project", source_type: "manifest" });
    expect(draft.statusCode).toBe(201);
    expect(draft.json()).toMatchObject({ status: "draft", wizard_step: 2 });
    const draftId = (draft.json() as { project_id: string }).project_id;
    expect((await request("PATCH" as "POST", `/developer-projects/${draftId}/draft`, { wizard_step: 3, origin_url: origin, manifest_url: `${origin}/manifest.json`, wizard_state_json: { source_checked: true } })).statusCode).toBe(200);
    await getPool().query("delete from core.local_app_projects where project_id=$1", [draftId]);

    const created = await request("POST", "/developer-projects", { display_name: "Local Test Project", origin_url: origin, source_type: "manifest", manifest_url: `${origin}/manifest.json`, feed_url: null });
    expect(created.statusCode).toBe(201);
    const projectId = (created.json() as { project_id: string }).project_id;
    expect(created.json()).not.toHaveProperty("author_id");

    expect((await request("POST", `/developer-projects/${projectId}/test-origin`)).json()).toMatchObject({ status: "connectivity_ok" });
    expect((await request("POST", `/developer-projects/${projectId}/trust-origin`, { confirmed: true })).json()).toMatchObject({ status: "origin_trusted" });
    const validationPayload = (await request("POST", `/developer-projects/${projectId}/validate-source`)).json();
    expect(validationPayload, JSON.stringify(validationPayload)).toMatchObject({ status: "source_valid", manifest_result_json: { valid: true, selected: { app_id: appId } } });
    expect((await request("POST", `/developer-projects/${projectId}/install`)).json()).toMatchObject({ status: "installed", installed_app_id: appId });
    const deployments = (await request("GET", `/developer-deployments?project_id=${projectId}`)).json() as { items: Array<Record<string, unknown>> };
    expect(deployments.items[0]).toMatchObject({ project_id: projectId, status: "running", is_active: true, runtime_plan_json: { type: "external_runtime" } });
    expect(deployments.items[0]?.["runtime_plan_hash"]).toMatch(/^[a-f0-9]{64}$/);
    const logs = (await request("GET", `/developer-logs?deployment_id=${deployments.items[0]?.["deployment_id"]}`)).json() as { items: Array<{ category: string }> };
    expect(logs.items.map((item) => item.category)).toEqual(expect.arrayContaining(["deployment", "build", "runtime", "installation"]));
    expect((await request("GET", `/developer-projects/${projectId}/runtime-status`)).json()).toMatchObject({ app_id: appId, local: true, trust_status: "unverified", open_url: `/app/${slug}` });

    await app.close();
  });
});
