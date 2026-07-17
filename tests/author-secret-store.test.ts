import { describe, expect, it } from "vitest";

import { decryptAuthorSecret, encryptAuthorSecret } from "../src/authors/author-secret-store.js";
import type { EnvConfig } from "../src/config/index.js";

describe("author credential encryption", () => {
  it("encrypts credentials with authenticated encryption", () => {
    const config = { AUTHOR_GIT_TOKEN_ENCRYPTION_KEY: "test-only-author-encryption-key-123456" } as EnvConfig;
    const encrypted = encryptAuthorSecret("github-token-value", config);
    expect(encrypted.ciphertext).not.toContain("github-token-value");
    expect(decryptAuthorSecret(encrypted, config)).toBe("github-token-value");
  });

  it("fails closed without a configured encryption key", () => {
    expect(() => encryptAuthorSecret("token", { AUTHOR_GIT_TOKEN_ENCRYPTION_KEY: "" } as EnvConfig)).toThrow("not configured");
  });
});
