import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";

import { verifyAuthorUpdateSignal } from "../src/apps/app-update-signal-verifier.js";
import type { EnvConfig } from "../src/config/index.js";

async function signedMaterial() {
  const root = await generateKeyPair("ES256");
  const author = await generateKeyPair("ES256");
  const rootPublic = { ...(await exportJWK(root.publicKey)), kid: "root-1", alg: "ES256" };
  const authorPublic = { ...(await exportJWK(author.publicKey)), kid: "author-1", alg: "ES256" };
  const now = Math.floor(Date.now() / 1000);
  const authorCertJws = await new SignJWT({
    typ: "hc-author-cert",
    jwks: { keys: [authorPublic] },
  })
    .setProtectedHeader({ alg: "ES256", kid: "root-1" })
    .setIssuer("hc-author-registry")
    .setSubject("talpaversum")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(root.privateKey);
  const updateSignalJws = await new SignJWT({
    typ: "hc-app-update",
    app_version: "1.2.3",
    manifest_sha256: "a".repeat(64),
    manifest_url: "https://inventory.example/.well-known/hc-app-manifest.json",
  })
    .setProtectedHeader({ alg: "ES256", kid: "author-1" })
    .setIssuer("talpaversum")
    .setSubject("talpaversum/inventory")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(author.privateKey);

  const config = {
    LICENSING_ROOT_JWKS_JSON: JSON.stringify({ keys: [rootPublic] }),
    LICENSING_CLOCK_SKEW_SECONDS: 60,
  } as EnvConfig;
  return { authorCertJws, updateSignalJws, config, author };
}

describe("author-signed update signals", () => {
  it("verifies the author certificate and binds update claims to its namespace", async () => {
    const material = await signedMaterial();
    await expect(
      verifyAuthorUpdateSignal({
        updateSignalJws: material.updateSignalJws,
        authorCertJws: material.authorCertJws,
        config: material.config,
      }),
    ).resolves.toMatchObject({
      author_id: "talpaversum",
      app_id: "talpaversum/inventory",
      app_version: "1.2.3",
      manifest_sha256: "a".repeat(64),
    });
  });

  it("rejects a signal for an app outside the certified author namespace", async () => {
    const material = await signedMaterial();
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({
      typ: "hc-app-update",
      app_version: "1.2.3",
      manifest_sha256: "a".repeat(64),
      manifest_url: "https://inventory.example/.well-known/hc-app-manifest.json",
    })
      .setProtectedHeader({ alg: "ES256", kid: "author-1" })
      .setIssuer("talpaversum")
      .setSubject("other/inventory")
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(material.author.privateKey);

    await expect(
      verifyAuthorUpdateSignal({
        updateSignalJws: forged,
        authorCertJws: material.authorCertJws,
        config: material.config,
      }),
    ).rejects.toThrow("outside the author namespace");
  });
});
