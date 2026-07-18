import { createHash } from "node:crypto";
import { cp, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { buildManifestHash } from "../apps/manifest-fetcher.js";
import { validateManifest, type AppManifest } from "../apps/manifest-validator.js";
import type { EnvConfig } from "../config/index.js";
import { ForbiddenError, HttpError } from "../shared/errors.js";

import { createDeveloperSourceProvider } from "./source-provider-adapter.js";

export type StagedDeveloperSource = {
  sourcePath: string;
  revision: string;
  manifest: AppManifest;
  manifestHash: string;
};

export const hashDeveloperValue = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function safeManifestPath(sourcePath: string, manifestPath: string) {
  const target = resolve(sourcePath, manifestPath);
  const child = relative(sourcePath, target);
  if (child.startsWith("..") || isAbsolute(child)) {
    throw new ForbiddenError("Manifest path escapes the staged source");
  }
  return target;
}

export async function stageDeveloperProjectSource(input: {
  deploymentId: string;
  row: Record<string, unknown>;
  connection?: Record<string, unknown>;
  config: EnvConfig;
}): Promise<StagedDeveloperSource> {
  const sourcePath = resolve(
    input.config.CORE_DATA_DIR,
    "developer-deployments",
    input.deploymentId,
    "source",
  );
  await mkdir(resolve(sourcePath, ".."), { recursive: true });
  const sourceType = String(input.row["source_type"]);
  let revision = String(input.row["validated_revision"] ?? input.row["source_revision"] ?? "");

  if (sourceType === "local_workspace") {
    if (!input.connection) throw new HttpError(409, "The workspace connection is unavailable");
    const workspace = await realpath(String(input.row["workspace_path"]));
    const root = await realpath(
      String((input.connection["metadata_json"] as Record<string, unknown>)["canonical_path"]),
    );
    const workspaceChild = relative(root, workspace);
    if (workspaceChild.startsWith("..") || isAbsolute(workspaceChild)) {
      throw new ForbiddenError("Workspace is outside the selected connection root");
    }
    await cp(workspace, sourcePath, {
      recursive: true,
      filter: (entry) =>
        !entry.split(/[\\/]/).some((part) => part === ".git" || part === "node_modules"),
    });
  } else if (["github", "gitlab", "git"].includes(sourceType)) {
    if (!input.connection) throw new HttpError(409, "The source connection is unavailable");
    const checkout = await createDeveloperSourceProvider(input.connection, input.config).checkout(
      String(input.row["repository"]),
      String(input.row["branch"] || "main"),
      sourcePath,
    );
    revision = checkout.revision;
  } else {
    throw new HttpError(409, "This project source does not require a staged runtime checkout");
  }

  const manifestPath = safeManifestPath(
    sourcePath,
    String(input.row["manifest_path"] || "manifest/app-manifest.json"),
  );
  const rawManifest = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(rawManifest) as AppManifest;
  await validateManifest(manifest);
  if (sourceType === "local_workspace") {
    revision = `workspace:${createHash("sha256").update(rawManifest).digest("hex")}`;
  }
  return {
    sourcePath,
    revision,
    manifest,
    manifestHash: buildManifestHash(manifest),
  };
}
