import { describe, expect, it } from "vitest";

import { buildAuditWhere } from "../src/web/routes/audit.js";

describe("audit read authorization", () => {
  it("pins own reads to current tenant and user", () => {
    const result = buildAuditWhere({}, { mode: "own", tenantId: "t1", userId: "u1" });
    expect(result.values).toEqual(["t1", "u1"]);
    expect(result.clauses.join(" ")).toContain("visibility = 'user'");
  });

  it("rejects tenant and user scope spoofing", () => {
    expect(() => buildAuditWhere({ tenant_id: "t2" }, { mode: "tenant", tenantId: "t1", userId: "u1" })).toThrow();
    expect(() => buildAuditWhere({ user_id: "u2" }, { mode: "own", tenantId: "t1", userId: "u1" })).toThrow();
  });

  it("accepts multiple platform tenant and application filters", () => {
    const result = buildAuditWhere({ tenant_id: "t1,t2", application_id: "a1,a2" }, { mode: "platform", tenantId: null, userId: "admin" });
    expect(result.values).toEqual([["t1", "t2"], ["a1", "a2"]]);
  });
});
