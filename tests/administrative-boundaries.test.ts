import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { PRIVILEGE_CATALOG } from "../src/access/privilege-catalog.js";
import { hasPrivilege } from "../src/access/privileges.js";

describe("platform administrative boundaries", () => {
  it("exposes exact author review and Registry privileges without legacy aliases", () => {
    const ids = PRIVILEGE_CATALOG.map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining([
      "platform.authors.review",
      "platform.author_registry.read",
      "platform.author_registry.keys.manage",
      "platform.author_registry.certificates.issue",
      "platform.author_registry.revoke",
      "platform.author_registry.audit.read",
      "platform.catalog.manage",
      "platform.apps.runtime.manage",
    ]));
    expect(ids).not.toEqual(expect.arrayContaining(["platform.authors.manage", "platform.author_registry.manage", "author_registry.admin"]));
  });

  it("does not infer authority across review, Registry, catalog, and runtime domains", () => {
    expect(hasPrivilege(["platform.authors.review"], "platform.author_registry.keys.manage")).toBe(false);
    expect(hasPrivilege(["platform.author_registry.read"], "platform.apps.runtime.manage")).toBe(false);
    expect(hasPrivilege(["platform.catalog.manage"], "platform.author_registry.read")).toBe(false);
    expect(hasPrivilege(["platform.apps.runtime.manage"], "platform.catalog.manage")).toBe(false);
  });

  it("keeps external issuer approval separate from author approval and catalog submission", async () => {
    const source = await readFile(new URL("../src/web/routes/author-portal.ts", import.meta.url), "utf8");
    expect(source).toContain('mode === "trusted_self_hosted" ? "pending_review" : "not_applicable"');
    expect(source).toContain('external_issuer_approved: row.operating_mode !== "trusted_self_hosted" || row.external_issuer_status === "approved"');
    expect(source).toContain('/author-portal/admin/catalog/external-issuers/:authorId/action');
  });
});
