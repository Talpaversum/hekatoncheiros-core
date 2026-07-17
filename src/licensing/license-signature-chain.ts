import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK, type JSONWebKeySet, type JWTPayload } from "jose";

export type VerifiedLicenseSignatureChain = {
  authorId: string;
  authorKid: string;
  rootKid: string;
  certificatePayload: JWTPayload;
  licensePayload: JWTPayload;
};

function publicEd25519Keys(jwks: JSONWebKeySet, name: string): JWK[] {
  if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error(`${name} must contain at least one public key`);
  const kids = new Set<string>();
  for (const key of jwks.keys as JWK[]) {
    if (key.kty !== "OKP" || key.crv !== "Ed25519" || typeof key.kid !== "string" || !key.kid || typeof key.x !== "string" || !key.x) {
      throw new Error(`${name} must contain Ed25519 public keys with kid and x`);
    }
    if (key.d) throw new Error(`${name} must not contain private key material`);
    if (kids.has(key.kid)) throw new Error(`${name} contains duplicate kid ${key.kid}`);
    kids.add(key.kid);
  }
  return jwks.keys as JWK[];
}

export async function verifyLicenseSignatureChain(params: {
  rootJwks: JSONWebKeySet;
  registryIssuer: string;
  registryId?: string | null;
  authorCertJws: string;
  licenseJws: string;
  clockToleranceSeconds: number;
}): Promise<VerifiedLicenseSignatureChain> {
  publicEd25519Keys(params.rootJwks, "Registry root JWKS");
  const certificate = await jwtVerify(params.authorCertJws, createLocalJWKSet(params.rootJwks), {
    issuer: params.registryIssuer,
    clockTolerance: params.clockToleranceSeconds,
  });
  const certificateHeader = decodeProtectedHeader(params.authorCertJws);
  if (certificateHeader.alg !== "EdDSA" || typeof certificateHeader.kid !== "string" || !certificateHeader.kid) {
    throw new Error("Author certificate has an invalid protected header");
  }
  if (certificate.payload["typ"] !== "hc-author-cert") throw new Error("Invalid author certificate type");
  if (params.registryId && certificate.payload["registry_id"] !== params.registryId) {
    throw new Error("Author certificate Registry identity does not match the trusted Registry");
  }
  const authorId = certificate.payload.sub;
  if (typeof authorId !== "string" || !authorId) throw new Error("Author certificate is missing its author identity");
  const authorJwks = certificate.payload["jwks"] as JSONWebKeySet | undefined;
  if (!authorJwks) throw new Error("Author certificate does not contain author keys");
  publicEd25519Keys(authorJwks, "Author certificate JWKS");

  const license = await jwtVerify(params.licenseJws, createLocalJWKSet(authorJwks), {
    clockTolerance: params.clockToleranceSeconds,
  });
  const licenseHeader = decodeProtectedHeader(params.licenseJws);
  if (licenseHeader.alg !== "EdDSA" || typeof licenseHeader.kid !== "string" || !licenseHeader.kid) {
    throw new Error("License JWS has an invalid protected header");
  }
  if (license.payload["typ"] !== "hc-license") throw new Error("Invalid license type");
  if (license.payload.iss !== authorId) throw new Error("License issuer does not match the certified author identity");

  return {
    authorId,
    authorKid: licenseHeader.kid,
    rootKid: certificateHeader.kid,
    certificatePayload: certificate.payload,
    licensePayload: license.payload,
  };
}
