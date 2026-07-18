import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { AppManifest } from "../apps/manifest-validator.js";
import { HttpError } from "../shared/errors.js";

const run = promisify(execFile);

export async function readGitSource(input: {
  repository: string;
  branch: string;
  manifestPath: string;
  authMethod: string;
  credential?: string;
}) {
  const workRoot = await mkdtemp(resolve(tmpdir(), "hc-developer-git-"));
  const checkout = resolve(workRoot, "checkout");
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const cloneArgs: string[] = [];

  try {
    if (input.authMethod === "deploy_key") {
      if (!input.credential) throw new HttpError(409, "The Git deploy key is missing");
      const keyPath = resolve(workRoot, "deploy-key");
      await writeFile(keyPath, input.credential, { encoding: "utf8", mode: 0o600 });
      environment["GIT_SSH_COMMAND"] = `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
    } else if (input.credential) {
      const identity = input.credential.includes(":")
        ? input.credential
        : `oauth2:${input.credential}`;
      cloneArgs.push(
        "-c",
        `http.extraHeader=Authorization: Basic ${Buffer.from(identity).toString("base64")}`,
      );
    }

    cloneArgs.push(
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--branch",
      input.branch,
      input.repository,
      checkout,
    );
    await run("git", cloneArgs, { env: environment, maxBuffer: 2 * 1024 * 1024 });
    const canonicalCheckout = await realpath(checkout);
    const manifestFile = await realpath(resolve(canonicalCheckout, input.manifestPath));
    const child = relative(canonicalCheckout, manifestFile);
    if (child.startsWith("..") || isAbsolute(child))
      throw new HttpError(403, "Manifest path escapes the Git checkout");
    const raw = await readFile(manifestFile, "utf8");
    const revision = (
      await run("git", ["-C", canonicalCheckout, "rev-parse", "HEAD"], { env: environment })
    ).stdout.trim();
    return { revision, manifest: JSON.parse(raw) as AppManifest };
  } finally {
    await rm(workRoot, { recursive: true, force: true });
  }
}
