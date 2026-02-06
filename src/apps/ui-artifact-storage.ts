import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { EnvConfig } from "../config/index.js";

function resolveCoreDataDir(config: EnvConfig): string {
  return path.resolve(process.cwd(), config.CORE_DATA_DIR);
}

export function getUiPluginPath(config: EnvConfig, slug: string): string {
  return path.join(resolveCoreDataDir(config), "apps", slug, "ui", "plugin.js");
}

export async function saveUiPluginArtifact(params: {
  config: EnvConfig;
  slug: string;
  content: Buffer;
}): Promise<{ sha256: string; path: string }> {
  const { config, slug, content } = params;
  const filePath = getUiPluginPath(config, slug);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  return { sha256, path: filePath };
}

export async function readUiPluginArtifact(config: EnvConfig, slug: string): Promise<Buffer> {
  const filePath = getUiPluginPath(config, slug);
  return readFile(filePath);
}
