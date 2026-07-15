import { describe, expect, it } from "vitest";

import { decodeAuditCursor, encodeAuditCursor } from "../src/web/routes/audit.js";

describe("audit cursor pagination", () => {
  it("round trips timestamp and id so equal timestamps remain stable", () => {
    const cursor = encodeAuditCursor({ occurred_at: "2026-07-15T10:00:00.000Z", id: "00000000-0000-0000-0000-000000000002" });
    expect(decodeAuditCursor(cursor)).toEqual(["2026-07-15T10:00:00.000Z", "00000000-0000-0000-0000-000000000002"]);
  });
});
