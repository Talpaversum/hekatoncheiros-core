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

export function isDockerComposeRuntimeEnabled(config: EnvConfig): boolean {
  return config.APP_RUNTIME_DOCKER_ENABLED === true;
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

  const args = [
    "compose",
    "-p",
    plan.compose_project,
    "-f",
    composeFilePath,
    "up",
    "-d",
    "--build",
    plan.service_name,
  ];
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
