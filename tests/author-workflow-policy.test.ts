import { describe, expect, it } from "vitest";

import { AUTHOR_OPERATING_MODES, AUTHOR_ROLE_PERMISSIONS, assertWorkflowTransition, policyForMode } from "../src/authors/author-workflow-policy.js";

describe("author workflow policy", () => {
  it("exposes exactly the two official operating modes", () => {
    expect(AUTHOR_OPERATING_MODES).toEqual(["talpaversum_hosted", "trusted_self_hosted"]);
    expect(policyForMode("talpaversum_hosted")).toMatchObject({ registryRequired: true, officialCatalogEligible: true, runtimeManagement: "talpaversum_managed", licensingManagement: "talpaversum_hosted" });
    expect(policyForMode("trusted_self_hosted")).toMatchObject({ registryRequired: true, officialCatalogEligible: true, runtimeManagement: "external", licensingManagement: "external" });
  });

  it("does not grant global platform permissions through author roles", () => {
    for (const permissions of Object.values(AUTHOR_ROLE_PERMISSIONS)) {
      expect(permissions.every((permission) => permission.startsWith("author."))).toBe(true);
    }
  });

  it("rejects workflow shortcuts", () => {
    expect(() => assertWorkflowTransition("request", "draft", "approved")).toThrow("Invalid request status transition");
    expect(() => assertWorkflowTransition("app", "submitted", "approved")).not.toThrow();
    expect(() => assertWorkflowTransition("submission", "approved", "published")).not.toThrow();
  });
});
