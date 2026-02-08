import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SCHEMA_PATH, validateManifest } from "../src/apps/manifest-validator.js";

describe("manifest validator schema path", () => {
  it("uses absolute schema path independent of process.cwd", () => {
    const originalCwd = process.cwd();

    try {
      expect(path.isAbsolute(SCHEMA_PATH)).toBe(true);
      expect(existsSync(SCHEMA_PATH)).toBe(true);

      process.chdir(os.tmpdir());

      expect(path.isAbsolute(SCHEMA_PATH)).toBe(true);
      expect(existsSync(SCHEMA_PATH)).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("compiles draft-2020-12 schema and validates minimal manifest", async () => {
    const manifest = {
      app_id: "inventory-core",
      app_name: "Inventory Core",
      version: "1.0.0",
      vendor: {
        name: "Talpaversum",
      },
      tenancy: {
        scope: "tenant",
        cross_tenant_collaboration: {
          supported: false,
          shareables: [],
        },
      },
      data: {
        schemas: ["inventory"],
        no_cross_app_access: true,
      },
      privileges: {
        required: [],
        optional: [],
      },
      licensing: {
        enforced_by_app: true,
        offline_supported: false,
        modes: ["perpetual"],
        expiry_behavior: {
          non_destructive: true,
          read_only: false,
          api_read_only: false,
        },
      },
      integration: {
        slug: "inventory-core",
        api: {
          exposes: {
            base_path: "/apps/inventory-core",
            version: "v1",
          },
          consumes_core_api: true,
        },
        events: {
          emits: [],
          consumes: [],
          idempotent_consumers: true,
        },
        ui: {
          artifact: {
            url: "https://example.com/inventory/ui",
            auth: "core-signed-token",
          },
          nav_entries: [],
        },
      },
    };

    await expect(validateManifest(manifest)).resolves.toBeUndefined();
  });
});
