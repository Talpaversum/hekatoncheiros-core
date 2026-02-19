import { HttpError } from "../shared/errors.js";

export const HC_APP_ID_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;

export function isValidAuthorScopedAppId(appId: string): boolean {
  return HC_APP_ID_PATTERN.test(appId);
}

export function assertAuthorScopedAppId(appId: string): void {
  if (!isValidAuthorScopedAppId(appId)) {
    throw new HttpError(400, "app_id must use <author_id>/<slug> format");
  }
}

export function legacyAppIdToAuthorScoped(legacyAppId: string): string {
  const normalized = legacyAppId.trim().toLowerCase();
  if (!normalized) {
    return normalized;
  }

  if (isValidAuthorScopedAppId(normalized)) {
    return normalized;
  }

  if (normalized.startsWith("com.")) {
    const parts = normalized.split(".").filter(Boolean);
    if (parts.length >= 3) {
      const vendor = parts[1];
      const product = parts[parts.length - 1];
      return `${vendor}/${product}`;
    }
  }

  if (normalized.startsWith("hc-app-")) {
    return `talpaversum/${normalized.slice("hc-app-".length)}`;
  }

  if (/^[a-z0-9_.-]+$/.test(normalized)) {
    return `talpaversum/${normalized}`;
  }

  return normalized;
}
