import { afterEach, describe, expect, it, vi } from "vitest";

import { onboardAuthor } from "../src/authors/author-registry-client.js";
import type { EnvConfig } from "../src/config/index.js";

const config = {
  AUTHOR_REGISTRY_URL: "https://registry.example",
  AUTHOR_REGISTRY_ALLOW_HTTP: false,
} as EnvConfig;

afterEach(() => vi.unstubAllGlobals());

describe("author registry client", () => {
  it("orchestrates author creation, public key registration, and certificate issuance", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ author_id: "aut_123", display_name: "Example" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ inserted: 1 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ author_id: "aut_123", status: "active" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ author_cert_jws: "cert.jws", root_kid: "root-1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      onboardAuthor({
        config,
        displayName: "Example",
        operatingMode: "trusted_self_hosted",
        jwks: { keys: [{ kty: "OKP", crv: "Ed25519", x: "public", kid: "author-1" }] },
        ttlDays: 365,
        delegatedUserToken: "delegated-token",
      }),
    ).resolves.toEqual({
      author_id: "aut_123",
      display_name: "Example",
      author_cert_jws: "cert.jws",
      root_kid: "root-1",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://registry.example/v1/admin/authors");
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe("https://registry.example/v1/admin/authors/aut_123/keys");
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe("https://registry.example/v1/admin/authors/aut_123/certificates");
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        "x-hc-user-delegation": "delegated-token",
      }),
    });
  });

  it("rejects private author key material before contacting the registry", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      onboardAuthor({
        config,
        displayName: "Example",
        operatingMode: "trusted_self_hosted",
        jwks: { keys: [{ kty: "OKP", kid: "author-1", x: "public", d: "private" }] },
        ttlDays: 365,
        delegatedUserToken: "delegated-token",
      }),
    ).rejects.toThrow("public keys only");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
