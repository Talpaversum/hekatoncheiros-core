import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import type { EnvConfig } from "../config/index.js";
import { HttpError } from "../shared/errors.js";

export const DEVELOPER_SOURCE_TYPES = [
  "github",
  "gitlab",
  "git",
  "local_workspace",
  "manifest",
  "private_feed",
] as const;
export type DeveloperSourceType = (typeof DEVELOPER_SOURCE_TYPES)[number];

export function workspaceRoots(config: EnvConfig) {
  return (config.DEVELOPER_WORKSPACE_ROOTS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(item));
}

export async function canonicalizeWorkspacePath(input: string, config: EnvConfig) {
  if (!isAbsolute(input)) throw new HttpError(400, "Local workspace path must be absolute");
  const canonical = await realpath(input);
  const allowed = await Promise.all(
    workspaceRoots(config).map(async (root) => realpath(root).catch(() => resolve(root))),
  );
  if (
    !allowed.some((root) => {
      const child = relative(root, canonical);
      return child === "" || (!child.startsWith("..") && !isAbsolute(child));
    })
  )
    throw new HttpError(403, "Local workspace is outside configured workspace roots");
  return canonical;
}

export function validateRepositoryReference(provider: DeveloperSourceType, repository: string) {
  if (provider === "github" || provider === "gitlab") {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
      throw new HttpError(400, "Repository must use owner/name format");
    return repository;
  }
  if (provider === "git") {
    if (!repository.startsWith("git@")) {
      const url = new URL(repository);
      if (url.protocol !== "https:")
        throw new HttpError(400, "Git repository must use HTTPS or SSH");
      if (url.username || url.password)
        throw new HttpError(400, "Git credentials must use a connection reference");
    }
    return repository;
  }
  return repository;
}
