import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { EnvConfig } from "../config/index.js";

type Secret = { ciphertext: string; iv: string; tag: string };
const key = (config: EnvConfig) => {
  const source = config.DEVELOPER_CONNECTION_ENCRYPTION_KEY;
  if (!source || source.length < 32) throw Object.assign(new Error("Developer connection encryption is not configured"), { statusCode: 503 });
  return createHash("sha256").update(source).digest();
};
export function encryptDeveloperSecret(value: string, config: EnvConfig): Secret {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key(config), iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
export function decryptDeveloperSecret(value: Secret, config: EnvConfig) {
  const decipher = createDecipheriv("aes-256-gcm", key(config), Buffer.from(value.iv, "base64")); decipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
