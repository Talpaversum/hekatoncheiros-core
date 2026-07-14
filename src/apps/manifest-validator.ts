import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ValidateFunction } from "ajv";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type AppManifest = Record<string, unknown>;

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const SCHEMA_RELATIVE_PATH = path.join("schemas", "app-manifest.schema.json");
export const MANIFEST_SCHEMA_ID = "https://hekatoncheiros.local/schemas/app-manifest.schema.json";

let validator: ValidateFunction | null = null;
const RESERVED_PRIVILEGE_PREFIXES = ["core.", "platform.", "tenant."];

function isReservedPrivilegeNamespace(privilege: string): boolean {
  return RESERVED_PRIVILEGE_PREFIXES.some((prefix) => privilege.startsWith(prefix));
}

function validateReservedRequiredPrivileges(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      validateReservedRequiredPrivileges(item);
    }
    return;
  }

  if (!node || typeof node !== "object") {
    return;
  }

  const record = node as Record<string, unknown>;
  const requiredPrivileges = record["required_privileges"];
  if (Array.isArray(requiredPrivileges)) {
    for (const privilege of requiredPrivileges) {
      if (typeof privilege === "string" && isReservedPrivilegeNamespace(privilege)) {
        throw new Error(
          `Invalid required_privilege "${privilege}": reserved namespaces core./platform./tenant. are not allowed in app manifests.`,
        );
      }
    }
  }

  for (const value of Object.values(record)) {
    validateReservedRequiredPrivileges(value);
  }
}

function validateLocalizationMetadata(manifest: AppManifest): void {
  const localization = manifest["localization"] as
    | {
        supported_locales?: unknown;
        resources?: unknown;
      }
    | undefined;
  const supported = Array.isArray(localization?.supported_locales)
    ? localization.supported_locales.filter((item): item is string => typeof item === "string")
    : [];
  const resources = Array.isArray(localization?.resources)
    ? localization.resources.filter(
        (item): item is { locale: string; path: string } =>
          Boolean(item) && typeof item === "object" && typeof item.locale === "string" && typeof item.path === "string",
      )
    : [];
  const resourceLocales = new Set<string>();
  const resourcePaths = new Set<string>();
  for (const resource of resources) {
    if (resourceLocales.has(resource.locale)) {
      throw new Error(`Localization resource locale is duplicated: ${resource.locale}`);
    }
    if (resourcePaths.has(resource.path)) {
      throw new Error(`Localization resource path is duplicated: ${resource.path}`);
    }
    if (!supported.includes(resource.locale)) {
      throw new Error(`Localization resource locale is not declared as supported: ${resource.locale}`);
    }
    resourceLocales.add(resource.locale);
    resourcePaths.add(resource.path);
  }
  for (const locale of supported) {
    if (!resourceLocales.has(locale)) {
      throw new Error(`Localization resource is missing for supported locale: ${locale}`);
    }
  }
}

function findRepoRoot(startDir: string): string {
  let currentDir = startDir;

  while (true) {
    const schemaCandidate = path.resolve(currentDir, SCHEMA_RELATIVE_PATH);
    if (existsSync(schemaCandidate)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(
        `Cannot locate repo root: missing ${SCHEMA_RELATIVE_PATH} (searched upwards from ${startDir}).`,
      );
    }

    currentDir = parentDir;
  }
}

export const REPO_ROOT = findRepoRoot(__dirname);
export const SCHEMA_PATH = path.resolve(REPO_ROOT, SCHEMA_RELATIVE_PATH);

async function loadSchema(): Promise<ValidateFunction> {
  if (validator) {
    return validator;
  }
  const raw = await readFile(SCHEMA_PATH, "utf-8");
  const jsonSchema = JSON.parse(raw) as Record<string, unknown>;
  validator = ajv.compile(jsonSchema);
  return validator as ValidateFunction;
}

export async function validateManifest(manifest: AppManifest): Promise<void> {
  const validate = await loadSchema();
  const valid = validate(manifest);
  if (!valid) {
    const details = ajv.errorsText(validate.errors, { separator: "; " });
    throw new Error(`Manifest schema validation failed: ${details}`);
  }

  validateReservedRequiredPrivileges(manifest);
  validateLocalizationMetadata(manifest);
}
