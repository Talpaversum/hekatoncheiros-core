import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import { describe, expect, it } from "vitest";

import { verifyLicenseSignatureChain } from "../src/licensing/license-signature-chain.js";

async function chain() {
  const root = await generateKeyPair("EdDSA", { extractable: true });
  const author = await generateKeyPair("EdDSA", { extractable: true });
  const rootPublic = { ...(await exportJWK(root.publicKey)), kid: "test-root-1", alg: "EdDSA", use: "sig" } as JWK;
  const authorPublic = { ...(await exportJWK(author.publicKey)), kid: "test-author-1", alg: "EdDSA", use: "sig" } as JWK;
  const now = Math.floor(Date.now() / 1000);
  const certificate = await new SignJWT({
    typ: "hc-author-cert",
    jwks: { keys: [authorPublic] },
    registry_id: "hekatoncheiros-test",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-root-1" })
    .setIssuer("hc-author-registry")
    .setSubject("talpaversum")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(root.privateKey);
  const license = await new SignJWT({ typ: "hc-license", app: { app_id: "talpaversum/inventory" } })
    .setProtectedHeader({ alg: "EdDSA", kid: "test-author-1" })
    .setIssuer("talpaversum")
    .setSubject("tenant-1")
    .setIssuedAt(now)
    .setExpirationTime(now + 1800)
    .sign(author.privateKey);
  return { root, author, rootPublic, certificate, license, now };
}

describe("license signature chain", () => {
  it("verifies Registry root, author identity, and license signature", async () => {
    const value = await chain();
    await expect(
      verifyLicenseSignatureChain({
        rootJwks: { keys: [value.rootPublic] },
        registryIssuer: "hc-author-registry",
        registryId: "hekatoncheiros-test",
        authorCertJws: value.certificate,
        licenseJws: value.license,
        clockToleranceSeconds: 0,
      }),
    ).resolves.toMatchObject({ authorId: "talpaversum", authorKid: "test-author-1", rootKid: "test-root-1" });
  });

  it("rejects an untrusted Registry root", async () => {
    const value = await chain();
    const foreign = await chain();
    await expect(
      verifyLicenseSignatureChain({
        rootJwks: { keys: [foreign.rootPublic] },
        registryIssuer: "hc-author-registry",
        authorCertJws: value.certificate,
        licenseJws: value.license,
        clockToleranceSeconds: 0,
      }),
    ).rejects.toThrow();
  });

  it("rejects a false Registry identity and foreign author signature", async () => {
    const value = await chain();
    await expect(
      verifyLicenseSignatureChain({
        rootJwks: { keys: [value.rootPublic] },
        registryIssuer: "hc-author-registry",
        registryId: "other-registry",
        authorCertJws: value.certificate,
        licenseJws: value.license,
        clockToleranceSeconds: 0,
      }),
    ).rejects.toThrow("Registry identity");

    const foreign = await generateKeyPair("EdDSA");
    const forgedLicense = await new SignJWT({ typ: "hc-license" })
      .setProtectedHeader({ alg: "EdDSA", kid: "foreign-author" })
      .setIssuer("talpaversum")
      .setIssuedAt(value.now)
      .setExpirationTime(value.now + 1800)
      .sign(foreign.privateKey);
    await expect(
      verifyLicenseSignatureChain({
        rootJwks: { keys: [value.rootPublic] },
        registryIssuer: "hc-author-registry",
        registryId: "hekatoncheiros-test",
        authorCertJws: value.certificate,
        licenseJws: forgedLicense,
        clockToleranceSeconds: 0,
      }),
    ).rejects.toThrow();
  });

  it("rejects missing trust material and private keys in public JWKS", async () => {
    const value = await chain();
    const rootPrivate = { ...(await exportJWK(value.root.privateKey)), kid: "test-root-1" } as JWK;
    const base = {
      registryIssuer: "hc-author-registry",
      authorCertJws: value.certificate,
      licenseJws: value.license,
      clockToleranceSeconds: 0,
    };
    await expect(verifyLicenseSignatureChain({ ...base, rootJwks: { keys: [] } })).rejects.toThrow("at least one public key");
    await expect(verifyLicenseSignatureChain({ ...base, rootJwks: { keys: [rootPrivate] } })).rejects.toThrow("private key material");
  });
});
