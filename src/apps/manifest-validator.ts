import { readFile } from "node:fs/promises";
import path from "node:path";

import Ajv from "ajv";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type AppManifest = Record<string, unknown>;

const ajv = new Ajv({ allErrors: true, strict: false });

let validator: ((data: unknown) => boolean) | null = null;

async function loadSchema(): Promise<(data: unknown) => boolean> {
  if (validator) {
    return validator;
  }
  const schemaPath = path.resolve(__dirname, "../../../schemas/app-manifest.schema.json");
  const raw = await readFile(schemaPath, "utf-8");
  const jsonSchema = JSON.parse(raw) as Record<string, unknown>;
  validator = ajv.compile(jsonSchema);
  return validator;
}

export async function validateManifest(manifest: AppManifest): Promise<void> {
  const validate = await loadSchema();
  const valid = validate(manifest);
  if (!valid) {
    const details = ajv.errorsText(validate.errors, { separator: "; " });
    throw new Error(`Manifest schema validation failed: ${details}`);
  }
}
