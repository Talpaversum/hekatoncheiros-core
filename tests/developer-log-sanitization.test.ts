import { describe, expect, it } from "vitest";

import { sanitizeDeveloperLog } from "../src/developer/log-service.js";
describe("developer log sanitization", () => {
  it("redacts credentials and private keys", () => {
    const value = sanitizeDeveloperLog(
      "token=abc123 password=hunter2 Authorization:Bearer.secret -----BEGIN PRIVATE KEY----- hidden -----END PRIVATE KEY-----",
    );
    expect(value).not.toContain("abc123");
    expect(value).not.toContain("hunter2");
    expect(value).not.toContain(" hidden ");
    expect(sanitizeDeveloperLog("Authorization: Basic dXNlcjpzZWNyZXQ=")).not.toContain(
      "dXNlcjpzZWNyZXQ=",
    );
    expect(value).toContain("REDACTED");
  });
});
