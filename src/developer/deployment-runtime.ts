import { execFile } from "node:child_process";
import { access, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

import type { AppManifest } from "../apps/manifest-validator.js";
import type { EnvConfig } from "../config/index.js";
import { HttpError } from "../shared/errors.js";

import { hashDeveloperValue } from "./deployment-source.js";
import { sanitizeDeveloperLog } from "./log-service.js";

const run = promisify(execFile);
const safeName = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .slice(0, 63);

export type DeveloperRuntimePlan = {
  type: "dockerfile" | "docker_compose" | "external_runtime" | "unmanaged";
  source_path: string | null;
  base_url: string;
  health_path: string;
  docker_network: string | null;
  compose_project: string | null;
  service_name: string | null;
  compose_file: string | null;
  dockerfile: string | null;
  image: string | null;
  container_name: string | null;
};

export type DeveloperRuntimeResult = {
  status: "started" | "external" | "unmanaged";
  runtime_type: DeveloperRuntimePlan["type"];
  compose_project?: string;
  service_name?: string;
  container_name?: string;
  image?: string;
};

async function firstExisting(sourcePath: string, candidates: string[]) {
  for (const candidate of candidates) {
    try {
      await access(resolve(sourcePath, candidate));
      return candidate;
    } catch {
      // Try the next conventional filename.
    }
  }
  return null;
}

export async function buildDeveloperRuntimePlan(input: {
  deploymentId: string;
  projectId: string;
  runtimeType: string;
  sourcePath: string | null;
  manifest: AppManifest;
  config: EnvConfig;
}): Promise<{ plan: DeveloperRuntimePlan; hash: string }> {
  const baseUrl = String(input.manifest["base_url"] ?? "");
  if (!baseUrl) throw new HttpError(409, "The manifest must define base_url for deployment");
  const parsedBaseUrl = new URL(baseUrl);
  const health = (input.manifest["runtime"] as { healthCheck?: { path?: string } } | undefined)
    ?.healthCheck?.path;
  const healthPath = typeof health === "string" && health.startsWith("/") ? health : "/health";
  const managed = input.runtimeType === "dockerfile" || input.runtimeType === "docker_compose";
  if (
    managed &&
    (!input.config.APP_RUNTIME_DOCKER_ENABLED || !input.config.DEVELOPER_DOCKER_NETWORK)
  ) {
    throw new HttpError(503, "Developer Docker runtime is supported but not configured");
  }
  if (managed && !input.sourcePath)
    throw new HttpError(409, "Managed runtime requires staged source");
  const serviceName = managed ? safeName(parsedBaseUrl.hostname) : null;
  if (managed && (!serviceName || serviceName !== parsedBaseUrl.hostname)) {
    throw new HttpError(
      400,
      "Managed runtime base_url hostname must be a safe Docker service name",
    );
  }
  const shortId = safeName(input.deploymentId.replace(/^dep_/, "")).slice(0, 20);
  const composeFile =
    input.runtimeType === "docker_compose" && input.sourcePath
      ? await firstExisting(input.sourcePath, [
          "docker-compose.yml",
          "docker-compose.yaml",
          "compose.yml",
          "compose.yaml",
        ])
      : null;
  const dockerfile =
    input.runtimeType === "dockerfile" && input.sourcePath
      ? await firstExisting(input.sourcePath, ["Dockerfile"])
      : null;
  if (input.runtimeType === "docker_compose" && !composeFile) {
    throw new HttpError(409, "Docker Compose source does not contain a compose file");
  }
  if (input.runtimeType === "dockerfile" && !dockerfile) {
    throw new HttpError(409, "Dockerfile source does not contain Dockerfile");
  }
  const plan: DeveloperRuntimePlan = {
    type:
      input.runtimeType === "docker_compose"
        ? "docker_compose"
        : input.runtimeType === "dockerfile"
          ? "dockerfile"
          : input.runtimeType === "external_runtime" ||
              input.runtimeType === "already_running_service"
            ? "external_runtime"
            : "unmanaged",
    source_path: input.sourcePath,
    base_url: parsedBaseUrl.origin,
    health_path: healthPath,
    docker_network: managed ? (input.config.DEVELOPER_DOCKER_NETWORK ?? null) : null,
    compose_project: input.runtimeType === "docker_compose" ? `hcdev-${shortId}` : null,
    service_name: serviceName,
    compose_file: composeFile,
    dockerfile,
    image:
      input.runtimeType === "dockerfile" ? `hcdev/${safeName(input.projectId)}:${shortId}` : null,
    container_name: input.runtimeType === "dockerfile" ? `hcdev-${shortId}` : null,
  };
  return { plan, hash: hashDeveloperValue(plan) };
}

async function execute(command: string, args: string[], cwd?: string) {
  try {
    const result = await run(command, args, {
      cwd,
      timeout: 10 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return sanitizeDeveloperLog(`${result.stdout}\n${result.stderr}`.trim()).slice(-100_000);
  } catch (error) {
    const message =
      error instanceof Error ? sanitizeDeveloperLog(error.message) : "Runtime command failed";
    throw new HttpError(502, message.slice(0, 2000));
  }
}

export async function startDeveloperRuntime(plan: DeveloperRuntimePlan): Promise<{
  result: DeveloperRuntimeResult;
  buildLog: string;
}> {
  if (plan.type === "unmanaged")
    return { result: { status: "unmanaged", runtime_type: plan.type }, buildLog: "" };
  if (plan.type === "external_runtime")
    return { result: { status: "external", runtime_type: plan.type }, buildLog: "" };
  if (!plan.source_path || !plan.docker_network || !plan.service_name) {
    throw new HttpError(409, "Managed runtime plan is incomplete");
  }
  if (plan.type === "docker_compose") {
    if (!plan.compose_file || !plan.compose_project)
      throw new HttpError(409, "Compose plan is incomplete");
    const overridePath = resolve(plan.source_path, `.hc-${plan.compose_project}.override.json`);
    const networkKey = "hc_developer_runtime";
    await writeFile(
      overridePath,
      JSON.stringify({
        services: { [plan.service_name]: { networks: [networkKey] } },
        networks: { [networkKey]: { external: true, name: plan.docker_network } },
      }),
    );
    const buildLog = await execute(
      "docker",
      [
        "compose",
        "-p",
        plan.compose_project,
        "-f",
        plan.compose_file,
        "-f",
        basename(overridePath),
        "up",
        "-d",
        "--build",
        "--wait",
        "--wait-timeout",
        "90",
        plan.service_name,
      ],
      plan.source_path,
    );
    return {
      result: {
        status: "started",
        runtime_type: plan.type,
        compose_project: plan.compose_project,
        service_name: plan.service_name,
      },
      buildLog,
    };
  }
  if (!plan.dockerfile || !plan.image || !plan.container_name)
    throw new HttpError(409, "Dockerfile plan is incomplete");
  const buildLog = await execute(
    "docker",
    ["build", "--file", plan.dockerfile, "--tag", plan.image, "."],
    plan.source_path,
  );
  await execute("docker", [
    "run",
    "--detach",
    "--name",
    plan.container_name,
    "--network",
    plan.docker_network,
    "--network-alias",
    plan.service_name,
    plan.image,
  ]);
  return {
    result: {
      status: "started",
      runtime_type: plan.type,
      container_name: plan.container_name,
      image: plan.image,
      service_name: plan.service_name,
    },
    buildLog,
  };
}

export async function waitForDeveloperRuntimeHealth(
  plan: DeveloperRuntimePlan,
  timeoutMs = 90_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unreachable";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL(plan.health_path, plan.base_url), {
        signal: AbortSignal.timeout(3000),
      });
      lastStatus = `HTTP ${response.status}`;
      if (response.ok)
        return {
          status: "healthy" as const,
          checked_url: new URL(plan.health_path, plan.base_url).toString(),
        };
    } catch {
      lastStatus = "unreachable";
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  }
  throw new HttpError(502, `Runtime health check failed (${lastStatus})`);
}

export async function removeDeveloperRuntime(plan: DeveloperRuntimePlan) {
  if (
    plan.type === "docker_compose" &&
    plan.compose_project &&
    plan.compose_file &&
    plan.source_path
  ) {
    await execute(
      "docker",
      ["compose", "-p", plan.compose_project, "-f", plan.compose_file, "down", "--remove-orphans"],
      plan.source_path,
    );
  }
  if (plan.type === "dockerfile" && plan.container_name) {
    try {
      await execute("docker", ["container", "rm", "--force", plan.container_name]);
    } catch {
      // Cleanup is best effort after a failed deployment.
    }
  }
}

async function runtimeContainerIds(plan: DeveloperRuntimePlan) {
  if (plan.type === "dockerfile" && plan.container_name) return [plan.container_name];
  if (plan.type === "docker_compose" && plan.compose_project && plan.service_name) {
    const output = await execute("docker", [
      "container",
      "ls",
      "--all",
      "--quiet",
      "--filter",
      `label=com.docker.compose.project=${plan.compose_project}`,
      "--filter",
      `label=com.docker.compose.service=${plan.service_name}`,
    ]);
    return output.split(/\s+/).filter(Boolean);
  }
  return [];
}

export async function performDeveloperRuntimeAction(
  plan: DeveloperRuntimePlan,
  action: "start" | "stop" | "restart" | "rebuild",
) {
  if (plan.type !== "dockerfile" && plan.type !== "docker_compose") {
    throw new HttpError(409, "This runtime does not support managed actions");
  }
  if (action === "rebuild") {
    await removeDeveloperRuntime(plan);
    return (await startDeveloperRuntime(plan)).result;
  }
  const containers = await runtimeContainerIds(plan);
  if (!containers.length) throw new HttpError(409, "Runtime container was not found");
  await execute("docker", ["container", action, ...containers]);
  return { status: action === "stop" ? "stopped" : "started", container_ids: containers };
}

export async function readDeveloperRuntimeLogs(plan: DeveloperRuntimePlan, tail: number) {
  const containers = await runtimeContainerIds(plan);
  if (!containers.length) throw new HttpError(409, "Runtime container was not found");
  return (
    await Promise.all(
      containers.map((container) =>
        execute("docker", ["container", "logs", "--timestamps", "--tail", String(tail), container]),
      ),
    )
  ).join("\n");
}
