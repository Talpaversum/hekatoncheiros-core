import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const docker = vi.hoisted(() => ({ failBuild: false, calls: [] as string[][] }));
vi.mock("node:child_process", () => ({
  execFile: (...input: unknown[]) => {
    const callback = input.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    const args = (input[1] as string[]) ?? [];
    docker.calls.push(args);
    if (docker.failBuild && args[0] === "build") {
      callback(new Error("docker build failed token=top-secret"), "", "");
      return;
    }
    callback(null, args[0] === "container" && args[1] === "ls" ? "abc123def456\n" : "ok\n", "");
  },
}));

import { buildApp } from "../src/app.js";
import { getPool } from "../src/db/pool.js";

describe("managed developer deployment", () => {
  const suffix = randomUUID().slice(0, 8);
  const tenantId = "tnt_default";
  const userId = `usr_managed_${suffix}`;
  const appId = `managed-test/${suffix}`;
  const slug = `managed-${suffix}`;
  let root: string;
  let workspace: string;
  let server: Server;
  let origin = "";
  let version = "1.0.0";
  let privileges = [`${slug}.read`];
  let projectId = "";

  const manifest = () => ({
    app_id: appId,
    app_name: "Managed Test App",
    version,
    vendor: { name: "Local developer" },
    tenancy: { scope: "tenant", cross_tenant_collaboration: { supported: false, shareables: [] } },
    data: { schemas: ["managed_test"], no_cross_app_access: true },
    privileges: { required: privileges, optional: [] },
    licensing: {
      required: false,
      enforced_by_app: true,
      offline_supported: false,
      modes: ["perpetual"],
      expiry_behavior: { non_destructive: true, read_only: false, api_read_only: false },
    },
    localization: {
      contract_version: 1,
      default_locale: "en",
      supported_locales: ["en"],
      resources: [{ locale: "en", path: "locales/en.json", format: "hc-flat-json-v1" }],
    },
    runtime: { healthCheck: { path: "/health" } },
    integration: {
      slug,
      api: { exposes: { base_path: `/apps/${slug}`, version: "v1" }, consumes_core_api: true },
      events: { emits: [], consumes: [], idempotent_consumers: true },
      ui: {
        artifact: { url: `${origin}/ui/plugin.js`, auth: "core-signed-token" },
        nav_entries: [{ label: "Overview", path: `/app/${slug}`, required_privileges: privileges }],
      },
    },
  });
  const writeSource = async () =>
    writeFile(join(workspace, "manifest", "app-manifest.json"), JSON.stringify(manifest()));

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "hc-managed-workspace-"));
    workspace = join(root, "application");
    await mkdir(join(workspace, "manifest"), { recursive: true });
    await writeFile(join(workspace, "Dockerfile"), "FROM scratch\n");
    server = createServer((request, response) => {
      if (request.method === "HEAD" && request.url === "/")
        return void response.writeHead(200).end();
      if (request.url === "/health") return void response.end('{"status":"healthy"}');
      if (request.url === "/manifest.json" || request.url === "/.well-known/hc-app-manifest.json")
        return void response.end(JSON.stringify(manifest()));
      if (request.url === "/ui/plugin.js") {
        if (!request.headers.authorization) return void response.writeHead(401).end();
        return void response.end("export default function mount() {}\n");
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Managed test server did not start");
    origin = `http://127.0.0.1:${address.port}`;
    await writeSource();
    process.env["NODE_ENV"] = "test";
    process.env["DATABASE_URL"] ??= "postgres://hc_user:hc_password@localhost:5432/hc_core";
    process.env["JWT_SECRET"] = "supersecretkeysupersecret";
    process.env["INSTALLER_TOKEN_SECRET"] = "installersecretinstallersecret";
    process.env["DEVELOPER_CONNECTION_ENCRYPTION_KEY"] = "managed-test-connection-key-value";
    process.env["DEVELOPER_WORKSPACE_ROOTS"] = root;
    process.env["APP_RUNTIME_DOCKER_ENABLED"] = "true";
    process.env["DEVELOPER_DOCKER_NETWORK"] = "test-network";
    process.env["DEVELOPER_RUNTIME_START_TIMEOUT_MS"] = "500";
  });

  afterAll(async () => {
    if (projectId)
      await getPool().query("delete from core.local_app_projects where project_id=$1", [projectId]);
    await getPool().query("delete from core.developer_connections where owner_user_id=$1", [
      userId,
    ]);
    await getPool().query("delete from core.installed_apps where app_id=$1", [appId]);
    await getPool().query("delete from core.trusted_origins where origin=$1", [origin]);
    await getPool().query("delete from core.user_privileges where user_id=$1", [userId]);
    await getPool().query("delete from core.users where id=$1", [userId]);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  });

  it("builds a local workspace and preserves its active deployment after a failed update", async () => {
    const app = await buildApp();
    await getPool().query(
      "insert into core.users(id,email,password_hash,status) values($1,$2,'test-only','active')",
      [userId, `${userId}@example.test`],
    );
    await getPool().query(
      "insert into core.user_privileges(user_id,tenant_id,privilege) select $1,$2,unnest($3::text[])",
      [
        userId,
        tenantId,
        [
          "developer.projects.read",
          "developer.projects.create",
          "developer.projects.manage",
          "developer.deployments.run",
          "developer.logs.read",
          "developer.runtime.manage",
          "developer.connections.personal.manage",
          "developer.connections.use",
        ],
      ],
    );
    const token = await new SignJWT({ tenant_id: tenantId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuer("hekatoncheiros-core")
      .setAudience("hc-user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(process.env["JWT_SECRET"]));
    const request = (method: "GET" | "POST" | "PATCH", url: string, payload?: object) =>
      app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    const connection = await request("POST", "/developer-connections", {
      visibility: "personal",
      provider: "local_workspace",
      auth_method: "workspace_root",
      owner_label: "Managed workspace",
      metadata: { path: root },
      scopes: [],
    });
    expect(connection.statusCode).toBe(201);
    const draft = await request("POST", "/developer-projects/drafts", {
      display_name: "Managed project",
      source_type: "local_workspace",
    });
    projectId = draft.json().project_id as string;
    await request("PATCH", `/developer-projects/${projectId}/draft`, {
      wizard_step: 6,
      origin_url: origin,
      source_connection_id: connection.json().connection_id,
      workspace_path: workspace,
      manifest_path: "manifest/app-manifest.json",
      runtime_type: "dockerfile",
    });
    expect((await request("POST", `/developer-projects/${projectId}/sync`)).json()).toMatchObject({
      update_status: "validation_required",
    });
    await request("POST", `/developer-projects/${projectId}/test-origin`);
    await request("POST", `/developer-projects/${projectId}/trust-origin`, { confirmed: true });
    expect(
      (await request("POST", `/developer-projects/${projectId}/validate-source`)).json(),
    ).toMatchObject({ status: "source_valid" });
    const installed = await request("POST", `/developer-projects/${projectId}/install`);
    expect(installed.statusCode, installed.body).toBe(201);
    const firstRevision = installed.json().deployed_revision as string;
    expect(docker.calls.some((args) => args[0] === "build")).toBe(true);
    expect((await request("POST", `/developer-projects/${projectId}/sync`)).json()).toMatchObject({
      update_status: "up_to_date",
    });

    version = "2.0.0";
    privileges = [...privileges, `${slug}.admin`];
    await writeSource();
    expect((await request("POST", `/developer-projects/${projectId}/sync`)).json()).toMatchObject({
      update_status: "runtime_approval_required",
    });
    expect(
      (await request("POST", `/developer-projects/${projectId}/validate-source`)).statusCode,
    ).toBe(409);
    expect(
      (
        await request("POST", `/developer-projects/${projectId}/approve-runtime`, {
          confirmed: true,
        })
      ).json(),
    ).toMatchObject({ update_status: "validation_required" });
    await request("POST", `/developer-projects/${projectId}/validate-source`);
    docker.failBuild = true;
    const failed = await request("POST", `/developer-projects/${projectId}/install`);
    expect(failed.statusCode).toBe(502);
    const projects = await request("GET", "/developer-projects");
    expect(
      projects.json().items.find((item: { project_id: string }) => item.project_id === projectId),
    ).toMatchObject({ deployed_revision: firstRevision, deployment_status: "running" });
    const deployments = await request("GET", `/developer-deployments?project_id=${projectId}`);
    expect(
      deployments.json().items.filter((item: { is_active: boolean }) => item.is_active),
    ).toHaveLength(1);
    expect(deployments.json().items[0]).toMatchObject({ status: "failed", is_active: false });
    const logs = await request(
      "GET",
      `/developer-logs?deployment_id=${deployments.json().items[0].deployment_id}`,
    );
    expect(JSON.stringify(logs.json())).not.toContain("top-secret");
    docker.failBuild = false;
    await app.close();
  });
});
