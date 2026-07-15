import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../src/db/pool.js", () => ({ getPool: () => ({ query }) }));

import { normalizeAuditInput, recordAudit } from "../src/audit/audit-service.js";

describe("audit service compatibility", () => {
  beforeEach(() => query.mockReset().mockResolvedValue({ rowCount: 1 }));

  it("maps the legacy recordAudit shape to structured columns", async () => {
    await recordAudit({ tenantId: "t1", actorUserId: "u1", effectiveUserId: "u1", action: "account.update", objectRef: "u1", metadata: {} });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][1]).toEqual(expect.arrayContaining(["t1", "u1", "identity.user.updated", "user"]));
  });

  it("keeps platform scope independent from the caller tenant", () => {
    const event = normalizeAuditInput({ tenantId: "t1", actorUserId: "u1", effectiveUserId: "u1", action: "platform.instance.update", objectRef: "instance", metadata: {} });
    expect(event).toMatchObject({ tenantId: null, scope: "platform", visibility: "platform_admin", eventType: "platform.configuration.updated" });
  });
});
