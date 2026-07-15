import { describe, expect, it } from "vitest";

import { buildAuditWhere } from "../src/web/routes/audit.js";

describe("audit route query contract", () => {
  it("builds all documented multi-value filters as arrays", () => {
    const result = buildAuditWhere({ severity: "warning,error", outcome: "failure,denied", event_type: "auth.login.failed,app.operation.denied" }, { mode: "platform", tenantId: null, userId: "admin" });
    expect(result.values).toEqual([["auth.login.failed", "app.operation.denied"], ["warning", "error"], ["failure", "denied"]]);
  });
});
