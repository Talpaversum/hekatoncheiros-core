import { describe, expect, it } from "vitest";

import {
  buildDockerComposeServiceContainerListArgs,
  buildDockerComposeUpArgs,
  isDockerComposeRuntimeEnabled,
  startDockerComposeAppRuntime,
} from "../src/apps/app-runtime-docker-compose.js";
import { buildAppRuntimeDeploymentPlan } from "../src/apps/app-runtime-plan.js";
import type { EnvConfig } from "../src/config/index.js";

function testConfig(enabled: boolean): EnvConfig {
  return {
    NODE_ENV: "test",
    PORT: 3000,
    DATABASE_URL: "postgres://hc_user:hc_password@localhost:5432/hc_core",
    CORE_DATA_DIR: "./core-data",
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
    APP_RUNTIME_DOCKER_ENABLED: enabled,
  };
}

function composePlan() {
  return buildAppRuntimeDeploymentPlan({
    app_id: "talpaversum/inventory",
    slug: "inventory",
    base_url: "http://inventory:4010",
    deployment: {
      type: "compose",
      service_name: "inventory",
      internal_base_url: "http://inventory:4010",
      package_url: "https://apps.example/packages/inventory.tar.gz",
      compose_project: "hekatoncheiros-core",
      compose_file: "docker-compose.app.yml",
    },
  });
}

describe("Docker Compose app runtime", () => {
  it("waits for the app service healthcheck before returning", () => {
    expect(buildDockerComposeUpArgs(composePlan())).toEqual([
      "compose",
      "-p",
      "hekatoncheiros-core",
      "-f",
      "docker-compose.app.yml",
      "up",
      "-d",
      "--build",
      "--wait",
      "--wait-timeout",
      "60",
      "inventory",
    ]);
  });

  it("selects only containers belonging to the planned Compose service", () => {
    expect(
      buildDockerComposeServiceContainerListArgs({
        compose_project: "hekatoncheiros-core",
        service_name: "inventory",
      }),
    ).toEqual([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      "label=com.docker.compose.project=hekatoncheiros-core",
      "--filter",
      "label=com.docker.compose.service=inventory",
    ]);
  });

  it("is disabled unless explicitly enabled", async () => {
    expect(isDockerComposeRuntimeEnabled(testConfig(false))).toBe(false);
    expect(isDockerComposeRuntimeEnabled(testConfig(true))).toBe(true);

    await expect(
      startDockerComposeAppRuntime({
        config: testConfig(false),
        plan: composePlan(),
        composeFilePath: "/tmp/docker-compose.app.yml",
        workdir: "/tmp",
      }),
    ).rejects.toThrow("Docker Compose runtime is disabled");
  });
});
