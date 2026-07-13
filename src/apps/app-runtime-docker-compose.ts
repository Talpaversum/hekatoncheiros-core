import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { EnvConfig } from "../config/index.js";

import type { AppRuntimeDeploymentPlan } from "./app-runtime-plan.js";
import { assertComposeRuntimePlan } from "./app-runtime-plan.js";

const execFileAsync = promisify(execFile);

export type DockerComposeRuntimeResult = {
  status: "started";
  command: string[];
  stdout: string;
  stderr: string;
};

export type DockerComposeRuntimeRemovalResult = {
  status: "removed" | "not_found";
  container_ids: string[];
};

export type DockerComposeRuntimeIdentity = {
  compose_project: string;
  service_name: string;
};

export function isDockerComposeRuntimeEnabled(config: EnvConfig): boolean {
  return config.APP_RUNTIME_DOCKER_ENABLED === true;
}

export function buildDockerComposeUpArgs(plan: AppRuntimeDeploymentPlan): string[] {
  assertComposeRuntimePlan(plan);
  if (!plan.compose_file) {
    throw new Error("compose deployment requires compose_file");
  }

  return [
    "compose",
    "-p",
    plan.compose_project,
    "-f",
    plan.compose_file,
    "up",
    "-d",
    "--build",
    "--wait",
    "--wait-timeout",
    "60",
    plan.service_name,
  ];
}

export function buildDockerComposeServiceContainerListArgs(
  identity: DockerComposeRuntimeIdentity,
): string[] {
  return [
    "container",
    "ls",
    "--all",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${identity.compose_project}`,
    "--filter",
    `label=com.docker.compose.service=${identity.service_name}`,
  ];
}

export async function startDockerComposeAppRuntime({
  config,
  plan,
  composeFilePath,
  workdir,
}: {
  config: EnvConfig;
  plan: AppRuntimeDeploymentPlan;
  composeFilePath: string;
  workdir: string;
}): Promise<DockerComposeRuntimeResult> {
  assertComposeRuntimePlan(plan);

  if (!isDockerComposeRuntimeEnabled(config)) {
    throw new Error("Docker Compose runtime is disabled");
  }

  const args = buildDockerComposeUpArgs({ ...plan, compose_file: composeFilePath });
  const result = await execFileAsync("docker", args, {
    cwd: workdir,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });

  return {
    status: "started",
    command: ["docker", ...args],
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export async function removeDockerComposeAppRuntime({
  config,
  identity,
}: {
  config: EnvConfig;
  identity: DockerComposeRuntimeIdentity;
}): Promise<DockerComposeRuntimeRemovalResult> {
  if (!isDockerComposeRuntimeEnabled(config)) {
    throw new Error("Docker Compose runtime is disabled");
  }

  const listResult = await execFileAsync(
    "docker",
    buildDockerComposeServiceContainerListArgs(identity),
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  const containerIds = listResult.stdout.split(/\s+/).filter(Boolean);
  if (containerIds.some((id) => !/^[a-f0-9]{12,64}$/i.test(id))) {
    throw new Error("Docker returned an invalid container ID");
  }
  if (containerIds.length === 0) {
    return { status: "not_found", container_ids: [] };
  }

  await execFileAsync("docker", ["container", "rm", "--force", ...containerIds], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });

  return { status: "removed", container_ids: containerIds };
}
