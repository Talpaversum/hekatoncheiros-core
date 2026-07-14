import { readFile } from "node:fs/promises";
import path from "node:path";

const manifestPath = path.resolve(process.argv[2] ?? "manifest/app-manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const localization = manifest.localization;
const errors = [];

if (!localization || localization.contract_version !== 1 || localization.default_locale !== "en") {
  errors.push("Manifest localization must use contract_version=1 and default_locale=en");
}
const supported = localization?.supported_locales ?? [];
if (!supported.includes("en")) errors.push("supported_locales must include en");
for (const locale of supported) {
  if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(locale)) errors.push(`Unsupported or non-canonical locale: ${locale}`);
}

const byLocale = new Map();
for (const resource of localization?.resources ?? []) {
  const resourcePath = path.resolve(path.dirname(manifestPath), resource.path);
  const raw = await readFile(resourcePath, "utf8").catch(() => null);
  if (raw === null) {
    errors.push(`Missing translation resource: ${resource.path}`);
    continue;
  }
  const keyMatches = [...raw.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)].map((match) => JSON.parse(`"${match[1]}"`));
  const duplicates = keyMatches.filter((key, index) => keyMatches.indexOf(key) !== index);
  for (const key of new Set(duplicates)) errors.push(`Duplicate key in ${resource.path}: ${key}`);
  let messages;
  try { messages = JSON.parse(raw); } catch { errors.push(`Invalid JSON: ${resource.path}`); continue; }
  if (!messages || Array.isArray(messages) || typeof messages !== "object") {
    errors.push(`Translation resource must be a flat JSON object: ${resource.path}`);
    continue;
  }
  for (const [key, value] of Object.entries(messages)) {
    if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/.test(key)) errors.push(`Invalid key in ${resource.path}: ${key}`);
    if (typeof value !== "string" || !value) errors.push(`Empty or invalid translation in ${resource.path}: ${key}`);
  }
  if (byLocale.has(resource.locale)) errors.push(`Duplicate resource locale: ${resource.locale}`);
  byLocale.set(resource.locale, messages);
}

for (const locale of supported) if (!byLocale.has(locale)) errors.push(`Missing declared locale resource: ${locale}`);
const english = byLocale.get("en") ?? {};
const placeholders = (value) => [...value.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)].map((match) => match[1]).sort().join(",");
for (const [locale, messages] of byLocale) {
  if (locale === "en") continue;
  for (const [key, value] of Object.entries(messages)) {
    if (!(key in english)) errors.push(`${locale} key is missing from English: ${key}`);
    else if (typeof value === "string" && placeholders(value) !== placeholders(english[key])) errors.push(`Placeholder mismatch in ${locale}: ${key}`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(error);
  process.exitCode = 1;
} else {
  console.info(`Localization valid: ${manifestPath} (${supported.join(", ")})`);
}

