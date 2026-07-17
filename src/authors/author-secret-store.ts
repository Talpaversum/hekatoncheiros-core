import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

import type { EnvConfig } from "../config/index.js";

export type EncryptedSecret = { ciphertext: string; iv: string; tag: string };

function encryptionKey(config: EnvConfig): Buffer {
  if (!config.AUTHOR_GIT_TOKEN_ENCRYPTION_KEY || config.AUTHOR_GIT_TOKEN_ENCRYPTION_KEY.length < 32) {
    throw Object.assign(new Error("Author credential encryption is not configured"), { statusCode: 503 });
  }
  return createHash("sha256").update(config.AUTHOR_GIT_TOKEN_ENCRYPTION_KEY, "utf8").digest();
}

export function encryptAuthorSecret(value: string, config: EnvConfig): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(config), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptAuthorSecret(value: EncryptedSecret, config: EnvConfig): string {
  try {
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(config), Buffer.from(value.iv, "base64"));
    decipher.setAuthTag(Buffer.from(value.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    throw Object.assign(new Error("Stored author credential cannot be decrypted"), { statusCode: 500 });
  }
}
