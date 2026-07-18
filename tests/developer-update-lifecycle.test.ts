import { describe, expect, it } from "vitest";

import {
  buildDeveloperProjectDiff,
  resolveDeveloperUpdateStatus,
} from "../src/web/routes/developer-project-sync.js";

const manifest = {
  base_url: "https://app.example",
  privileges: { required: ["app.read"] },
  licensing: { required: false },
  integration: {
    api: { exposes: { base_path: "/apps/example", version: "v1" } },
    ui: { artifact: { url: "/plugin.js", auth: "core-signed-token" } },
  },
  runtime: { image: "example:v1", environment: { PUBLIC_MODE: "on" } },
};

describe("developer update lifecycle", () => {
  it("distinguishes current, deployable, validation, and approval states", () => {
    expect(
      resolveDeveloperUpdateStatus({
        sameRevision: true,
        sameManifest: true,
        requiresRuntimeApproval: false,
      }),
    ).toBe("up_to_date");
    expect(
      resolveDeveloperUpdateStatus({
        sameRevision: false,
        sameManifest: true,
        requiresRuntimeApproval: false,
      }),
    ).toBe("deployment_required");
    expect(
      resolveDeveloperUpdateStatus({
        sameRevision: false,
        sameManifest: false,
        requiresRuntimeApproval: false,
      }),
    ).toBe("validation_required");
    expect(
      resolveDeveloperUpdateStatus({
        sameRevision: false,
        sameManifest: false,
        requiresRuntimeApproval: true,
      }),
    ).toBe("runtime_approval_required");
  });

  it("requires approval for security changes and only exposes environment variable names", () => {
    const changed = structuredClone(manifest);
    changed.privileges.required.push("app.admin");
    changed.runtime.environment = { PUBLIC_MODE: "off", PRIVATE_TOKEN: "must-not-leak" } as never;
    const result = buildDeveloperProjectDiff(manifest, changed, false, true);
    expect(result.requires_runtime_approval).toBe(true);
    expect(result.permissions.changed).toBe(true);
    expect(result.environment_variables.after).toEqual(["PRIVATE_TOKEN", "PUBLIC_MODE"]);
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
  });

  it("conservatively requires approval for a managed-runtime source revision change", () => {
    const result = buildDeveloperProjectDiff(manifest, manifest, true, true);
    expect(result.runtime).toMatchObject({ changed: true, managed_source_revision_changed: true });
    expect(result.requires_runtime_approval).toBe(true);
  });
});
