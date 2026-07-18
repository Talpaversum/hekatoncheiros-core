import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";

import type { AppManifest } from "../apps/manifest-validator.js";
import { HttpError } from "../shared/errors.js";

const run = promisify(execFile);

async function gitAuth(input: { authMethod: string; credential?: string }) {
  if (input.authMethod === "deploy_key" && !input.credential) {
    throw new HttpError(409, "The Git deploy key is missing");
  }
  const root = await mkdtemp(resolve(tmpdir(), "hc-developer-git-auth-"));
  const args: string[] = [];
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (input.authMethod === "deploy_key") {
    const keyPath = resolve(root, "deploy-key");
    await writeFile(keyPath, input.credential!, { encoding: "utf8", mode: 0o600 });
    env["GIT_SSH_COMMAND"] =
      `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  } else if (input.credential) {
    const identity = input.credential.includes(":")
      ? input.credential
      : `oauth2:${input.credential}`;
    args.push(
      "-c",
      `http.extraHeader=Authorization: Basic ${Buffer.from(identity).toString("base64")}`,
    );
  }
  return { root, args, env };
}

export async function listGitRefs(input: {
  repository: string;
  authMethod: string;
  credential?: string;
}) {
  const auth = await gitAuth(input);
  try {
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await run(
        "git",
        [...auth.args, "ls-remote", "--heads", "--tags", input.repository],
        {
          env: auth.env,
          timeout: 30_000,
          maxBuffer: 2 * 1024 * 1024,
        },
      );
    } catch {
      throw new HttpError(502, "Git repository refs could not be loaded");
    }
    return String(result.stdout)
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [revision, rawRef] = line.split(/\s+/, 2);
        if (!revision || !rawRef || rawRef.endsWith("^{}")) return [];
        const type = rawRef.startsWith("refs/tags/") ? ("tag" as const) : ("branch" as const);
        return [{ name: rawRef.replace(/^refs\/(heads|tags)\//, ""), type, revision }];
      });
  } finally {
    await rm(auth.root, { recursive: true, force: true });
  }
}

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
      environment["GIT_SSH_COMMAND"] =
        `ssh -i "${keyPath}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
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
    try {
      await run("git", cloneArgs, { env: environment, maxBuffer: 2 * 1024 * 1024 });
    } catch {
      throw new HttpError(502, "Git repository checkout failed");
    }
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
