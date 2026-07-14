export const LOCALIZATION_CONTRACT_VERSION = 1 as const;
export const PLATFORM_LOCALES = ["en", "cs", "sk", "de", "fr", "es"] as const;
export type PlatformLocale = (typeof PLATFORM_LOCALES)[number];
export const DEFAULT_LOCALE: PlatformLocale = "en";

export function isPlatformLocale(value: unknown): value is PlatformLocale {
  return typeof value === "string" && PLATFORM_LOCALES.includes(value as PlatformLocale);
}

export function resolvePlatformLocale(preferred: unknown): PlatformLocale {
  return isPlatformLocale(preferred) ? preferred : DEFAULT_LOCALE;
}

export function extractPlaceholders(message: string): string[] {
  return Array.from(message.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g), (match) => match[1]).sort();
}

export function validateTranslationResource(params: {
  locale: string;
  messages: Record<string, unknown>;
  englishMessages?: Record<string, unknown>;
}): string[] {
  const errors: string[] = [];
  if (!isPlatformLocale(params.locale)) {
    errors.push(`Unsupported locale identifier: ${params.locale}`);
  }
  for (const [key, value] of Object.entries(params.messages)) {
    if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/.test(key)) {
      errors.push(`Invalid translation key: ${key}`);
    }
    if (typeof value !== "string" || value.length === 0) {
      errors.push(`Translation must be a non-empty string: ${key}`);
      continue;
    }
    const english = params.englishMessages?.[key];
    if (typeof english === "string") {
      const expected = extractPlaceholders(english).join(",");
      const actual = extractPlaceholders(value).join(",");
      if (expected !== actual) {
        errors.push(`Placeholder mismatch for ${key}: expected [${expected}], got [${actual}]`);
      }
    }
  }
  if (params.locale !== "en" && params.englishMessages) {
    for (const key of Object.keys(params.messages)) {
      if (!(key in params.englishMessages)) {
        errors.push(`Translation key is missing from English resource: ${key}`);
      }
    }
  }
  return errors;
}

