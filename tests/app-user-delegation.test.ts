import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";

import { issueAppUserDelegation } from "../src/apps/app-user-delegation.js";

describe("app user delegation", () => {
  it("binds delegated identity and privileges to the target application", async () => {
    const token = await issueAppUserDelegation({
      appId: "talpaversum/licensing",
      username: "admin@example.com",
      correlationId: "req-1",
      config: {
        APP_DELEGATION_SIGNING_PRIVATE_JWK_JSON: '{"crv":"Ed25519","d":"2zZRDOPRk5kGWJ77q4781dtzvZ6epsJfQpzvPHD7mwU","x":"yX9arOMjShM8hvqmwg7B1abzkyAQYyfYPieQaTIh5Lk","kty":"OKP","kid":"core-delegation-dev-1"}',
        JWT_ISSUER: "hekatoncheiros-core",
      } as never,
      context: {
        requestId: "req-1",
        tenant: { tenantId: "tnt_default", mode: "row_level" },
        actor: { userId: "usr_admin", effectiveUserId: "usr_admin", impersonating: false, delegation: null, type: "user" },
        privileges: ["licensing.products.manage"],
      },
    });

    const verified = await jwtVerify(token, createLocalJWKSet({ keys: [{ crv: "Ed25519", x: "yX9arOMjShM8hvqmwg7B1abzkyAQYyfYPieQaTIh5Lk", kty: "OKP", kid: "core-delegation-dev-1" }] }), {
      issuer: "hekatoncheiros-core",
      audience: "hc-app:talpaversum/licensing",
    });
    expect(verified.payload).toMatchObject({
      typ: "hc-user-delegation",
      sub: "usr_admin",
      username: "admin@example.com",
      tenant_id: "tnt_default",
      privileges: ["licensing.products.manage"],
    });
  });
});
