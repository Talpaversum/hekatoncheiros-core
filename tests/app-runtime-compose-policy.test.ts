import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { validateAppRuntimeComposePolicy } from "../src/apps/app-runtime-compose-policy.js";
import { buildAppRuntimeDeploymentPlan } from "../src/apps/app-runtime-plan.js";

function composePlan() {
  return buildAppRuntimeDeploymentPlan({
    app_id: "talpaversum/inventory",
    slug: "inventory",
    base_url: "http://inventory:4010",
    deployment: {
      type: "compose",
      service_name: "inventory",
      internal_base_url: "http://inventory:4010",
      package_url: "https://apps.example/packages/inventory.tar.gz",
      compose_file: "docker-compose.app.yml",
    },
  });
}

async function writeCompose(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hc-compose-policy-"));
  const filePath = path.join(dir, "docker-compose.app.yml");
  await writeFile(filePath, content);
  return filePath;
}

describe("app runtime compose policy", () => {
  it("accepts a minimal compose file for the planned service", async () => {
    const composeFilePath = await writeCompose(
      "services:\n  inventory:\n    image: hc-app-inventory:local\n",
    );

    await expect(
      validateAppRuntimeComposePolicy({
        plan: composePlan(),
        composeFilePath,
      }),
    ).resolves.toMatchObject({
      status: "validated",
      compose_file_path: composeFilePath,
    });
  });

  it("rejects published ports", async () => {
    const composeFilePath = await writeCompose(
      'services:\n  inventory:\n    image: hc-app-inventory:local\n    ports:\n      - "4010:4010"\n',
    );

    await expect(
      validateAppRuntimeComposePolicy({
        plan: composePlan(),
        composeFilePath,
      }),
    ).rejects.toThrow("Compose file must not publish ports");
  });

  it("rejects host mounts", async () => {
    const composeFilePath = await writeCompose(
      "services:\n  inventory:\n    image: hc-app-inventory:local\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
    );

    await expect(
      validateAppRuntimeComposePolicy({
        plan: composePlan(),
        composeFilePath,
      }),
    ).rejects.toThrow("Compose file must not use host mounts or host devices");
  });

  it("rejects compose files without the planned service", async () => {
    const composeFilePath = await writeCompose(
      "services:\n  other:\n    image: hc-app-inventory:local\n",
    );

    await expect(
      validateAppRuntimeComposePolicy({
        plan: composePlan(),
        composeFilePath,
      }),
    ).rejects.toThrow("Compose file must define the planned service_name");
  });
});
