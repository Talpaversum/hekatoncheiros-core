import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import type { ValidateFunction } from "ajv";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type AppManifest = Record<string, unknown>;

const require = createRequire(import.meta.url);
const Ajv2020 = require("ajv/dist/2020");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const SCHEMA_RELATIVE_PATH = path.join("schemas", "app-manifest.schema.json");

let validator: ValidateFunction | null = null;

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
}
