import { createHash } from "node:crypto";

const MAX_IDENTIFIER_LENGTH = 63;
const HASH_SUFFIX_LENGTH = 8;

export function deriveAppSchemaName(appId: string): string {
  const sanitized = appId.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  const base = `app_${sanitized}`;

  if (base.length <= MAX_IDENTIFIER_LENGTH) {
    return base;
  }

  const hash = createHash("sha256").update(base).digest("hex").slice(0, HASH_SUFFIX_LENGTH);
  const maxBaseLength = MAX_IDENTIFIER_LENGTH - (HASH_SUFFIX_LENGTH + 1);
  const trimmed = base.slice(0, Math.max(0, maxBaseLength));

  return `${trimmed}_${hash}`;
}
