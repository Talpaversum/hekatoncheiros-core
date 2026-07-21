import { describe, expect, it } from "vitest";

import {
  nextAvailableIdentifier,
  normalizeIdentifierSlug,
  userSlugSource,
} from "../src/identity/generated-id.js";

describe("generated identity IDs", () => {
  it("normalizes whitespace, punctuation, and Czech diacritics", () => {
    expect(normalizeIdentifierSlug("  Jan Novák & Synové  ")).toBe("jan_novak_synove");
    expect(normalizeIdentifierSlug("***", "user")).toBe("user");
  });

  it("uses stable three-digit collision suffixes starting at 002", () => {
    expect(nextAvailableIdentifier("usr", "Jan Novák", [])).toBe("usr_jan_novak");
    expect(nextAvailableIdentifier("usr", "Jan Novák", ["usr_jan_novak"])).toBe(
      "usr_jan_novak_002",
    );
    expect(nextAvailableIdentifier("tnt", "Default", ["tnt_default", "tnt_default_002"])).toBe(
      "tnt_default_003",
    );
  });

  it("prefers nickname, display name, and then the email local part", () => {
    expect(
      userSlugSource({ nickname: "Neo", displayName: "Thomas", email: "one@example.test" }),
    ).toBe("Neo");
    expect(userSlugSource({ displayName: "Thomas", email: "one@example.test" })).toBe("Thomas");
    expect(userSlugSource({ email: "one@example.test" })).toBe("one");
  });

  it("keeps generated IDs within the database limit", () => {
    const id = nextAvailableIdentifier("tnt", "x".repeat(200), []);
    expect(id.length).toBeLessThanOrEqual(80);
  });
});
