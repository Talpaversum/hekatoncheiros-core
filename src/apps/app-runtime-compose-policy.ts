import { readFile } from "node:fs/promises";

import type { AppRuntimeDeploymentPlan } from "./app-runtime-plan.js";

const BLOCKED_LINE_PATTERNS = [
  { pattern: /^\s*ports\s*:/, message: "Compose file must not publish ports" },
  { pattern: /^\s*network_mode\s*:/, message: "Compose file must not set network_mode" },
  { pattern: /^\s*container_name\s*:/, message: "Compose file must not set container_name" },
  {
    pattern: /^\s*privileged\s*:\s*true\s*$/i,
    message: "Compose file must not use privileged containers",
  },
  { pattern: /^\s*cap_add\s*:/, message: "Compose file must not add Linux capabilities" },
  { pattern: /^\s*pid\s*:\s*host\s*$/i, message: "Compose file must not use host pid namespace" },
  { pattern: /^\s*ipc\s*:\s*host\s*$/i, message: "Compose file must not use host ipc namespace" },
];

const HOST_MOUNT_PATTERNS = [/^\s*-\s*\/[^:]+:/, /^\s*source\s*:\s*\//, /^\s*device\s*:\s*\//];

export type AppRuntimeComposePolicyValidation = {
  status: "validated";
  compose_file_path: string;
  warnings: string[];
};

function assertContainsService(composeText: string, serviceName: string): void {
  const servicesMatch = /^\s*services\s*:/m.test(composeText);
  if (!servicesMatch) {
    throw new Error("Compose file must define services");
  }

  const servicePattern = new RegExp(`^\\s{2}${serviceName.replaceAll(".", "\\.")}\\s*:`, "m");
  if (!servicePattern.test(composeText)) {
    throw new Error("Compose file must define the planned service_name");
  }
}

export async function validateAppRuntimeComposePolicy({
  plan,
  composeFilePath,
}: {
  plan: AppRuntimeDeploymentPlan;
  composeFilePath: string;
}): Promise<AppRuntimeComposePolicyValidation> {
  const composeText = await readFile(composeFilePath, "utf8");
  if (composeText.trim().length === 0) {
    throw new Error("Compose file must not be empty");
  }

  assertContainsService(composeText, plan.service_name);

  const lines = composeText.split(/\r?\n/);
  for (const line of lines) {
    for (const blocked of BLOCKED_LINE_PATTERNS) {
      if (blocked.pattern.test(line)) {
        throw new Error(blocked.message);
      }
    }

    if (HOST_MOUNT_PATTERNS.some((pattern) => pattern.test(line))) {
      throw new Error("Compose file must not use host mounts or host devices");
    }
  }

  return {
    status: "validated",
    compose_file_path: composeFilePath,
    warnings: [],
  };
}
