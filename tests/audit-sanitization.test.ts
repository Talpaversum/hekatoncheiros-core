import { describe, expect, it } from "vitest";

import { sanitizeAuditMetadata } from "../src/audit/audit-service.js";

describe("audit metadata sanitization", () => {
  it("redacts sensitive keys recursively and truncates strings", () => {
    const result = sanitizeAuditMetadata({ nested: { access_token: "secret", Password: "secret", safe: "x".repeat(5000) } });
    expect(result).toMatchObject({ nested: { access_token: "[REDACTED]", Password: "[REDACTED]" } });
    expect((result["nested"] as Record<string, string>)["safe"]).toHaveLength(4096);
  });

  it("bounds oversized metadata", () => {
    expect(sanitizeAuditMetadata({ values: Array.from({ length: 200 }, (_, index) => index) })).toMatchObject({ values: expect.any(Array) });
    expect((sanitizeAuditMetadata({ values: Array.from({ length: 200 }, (_, index) => index) })["values"] as unknown[])).toHaveLength(100);
  });
});
