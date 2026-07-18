import { describe, expect, it } from "vitest";

import { buildDeveloperRuntimePlan } from "../src/developer/deployment-runtime.js";

describe("developer runtime deployment plan", () => {
  it("creates a deterministic external health plan without Docker configuration", async () => {
    const first = await buildDeveloperRuntimePlan({
      deploymentId: "dep_123",
      projectId: "project-one",
      runtimeType: "already_running_service",
      sourcePath: null,
      manifest: { base_url: "https://app.example", runtime: { healthCheck: { path: "/ready" } } },
      config: {} as never,
    });
    const second = await buildDeveloperRuntimePlan({
      deploymentId: "dep_123",
      projectId: "project-one",
      runtimeType: "already_running_service",
      sourcePath: null,
      manifest: { base_url: "https://app.example", runtime: { healthCheck: { path: "/ready" } } },
      config: {} as never,
    });
    expect(first).toEqual(second);
    expect(first.plan).toMatchObject({
      type: "external_runtime",
      base_url: "https://app.example",
      health_path: "/ready",
    });
  });

  it("reports managed Docker runtime as supported but unconfigured", async () => {
    await expect(
      buildDeveloperRuntimePlan({
        deploymentId: "dep_123",
        projectId: "project-one",
        runtimeType: "dockerfile",
        sourcePath: "C:/source",
        manifest: { base_url: "http://app:4000" },
        config: { APP_RUNTIME_DOCKER_ENABLED: false } as never,
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
  });
});
