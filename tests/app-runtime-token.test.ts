import { readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";

import {
  APP_RUNTIME_TOKEN_CONTAINER_PATH,
  deliverAppRuntimeToken,
  issueAppRuntimeToken,
} from "../src/apps/app-runtime-token.js";
import type { EnvConfig } from "../src/config/index.js";

const dataDir = path.join(os.tmpdir(), "hc-runtime-token-tests");

function testConfig(): EnvConfig {
  return {
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: "postgres://localhost/test",
    CORE_DATA_DIR: dataDir,
    TENANCY_MODE: "row_level",
    JWT_ISSUER: "hekatoncheiros-core",
    JWT_AUDIENCE_USER: "hc-user",
    JWT_AUDIENCE_APP: "hc-app",
    JWT_SECRET: "supersecretkeysupersecret",
    INSTALLER_TOKEN_SECRET: "installersecretinstallersecret",
    INSTALLER_TOKEN_ISSUER: "hekatoncheiros-core-installer",
    DEFAULT_TENANT_ID: "tnt_default",
    LICENSING_CLOCK_SKEW_SECONDS: 600,
    LICENSING_CLOCK_SOFT_GRACE_SECONDS: 43_200,
    OFFLINE_LICENSE_PUBLIC_KEYS_JSON: "{}",
    LICENSING_ROOT_JWKS_JSON: '{"keys":[]}',
    LICENSING_DCR_SIGNING_PRIVATE_JWK_JSON: "",
    LICENSING_DCR_SIGNING_PUBLIC_JWK_JSON: "",
    LICENSING_OAUTH_CALLBACK_BASE_URL: "http://127.0.0.1:3000",
    APP_RUNTIME_DOCKER_ENABLED: true,
  };
}

afterEach(async () => rm(dataDir, { recursive: true, force: true }));

describe("managed app runtime token", () => {
  it("issues the app-scoped token and delivers it through a private file", async () => {
    const config = testConfig();
    const issued = await issueAppRuntimeToken({
      appId: "talpaversum/inventory",
      tenantId: "tnt_default",
      config,
    });
    const verified = await jwtVerify(issued.jwt, new TextEncoder().encode(config.JWT_SECRET), {
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE_APP,
    });
    expect(verified.payload).toMatchObject({
      app_id: "talpaversum/inventory",
      tenant_id: "tnt_default",
      purpose: "core-api",
    });

    const delivered = await deliverAppRuntimeToken({
      appId: "talpaversum/inventory",
      token: issued.jwt,
      config,
    });
    expect((await readFile(delivered.token_file_path, "utf8")).trim()).toBe(issued.jwt);
    expect(APP_RUNTIME_TOKEN_CONTAINER_PATH).toBe("/run/secrets/hc_core_app_token");
  });
});
