import { describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";

describe("GET /api/v1/context", () => {
  it("returns context for authenticated user", async () => {
    process.env["DATABASE_URL"] = "postgres://hc_user:hc_password@localhost:5432/hc_core";
    process.env["JWT_SECRET"] = "supersecretkeysupersecret";
    process.env["JWT_ISSUER"] = "hekatoncheiros-core";
    process.env["JWT_AUDIENCE_USER"] = "hc-user";
    process.env["DEFAULT_TENANT_ID"] = "tnt_default";

    const app = await buildApp();
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/context",
      headers: {
        authorization: "Bearer fake",
      },
    });

    expect(response.statusCode).toBe(401);
  });
});
