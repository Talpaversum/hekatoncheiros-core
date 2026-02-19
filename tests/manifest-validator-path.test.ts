import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SCHEMA_PATH, validateManifest } from "../src/apps/manifest-validator.js";

function buildMinimalManifest(requiredPrivileges: string[]) {
  return {
    app_id: "talpaversum/inventory-core",
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
      required: false,
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
        nav_entries: [
          {
            label: "Overview",
            path: "/app/inventory-core/overview",
            required_privileges: requiredPrivileges,
          },
        ],
      },
    },
  };
}

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
    const manifest = buildMinimalManifest(["app:vendor.crm:contacts.read"]);

    await expect(validateManifest(manifest)).resolves.toBeUndefined();
  });

  it("rejects reserved platform.* required_privileges", async () => {
    const manifest = buildMinimalManifest(["platform.apps.manage"]);

    await expect(validateManifest(manifest)).rejects.toThrow(
      'Invalid required_privilege "platform.apps.manage": reserved namespaces core./platform./tenant. are not allowed in app manifests.',
    );
  });

  it("rejects reserved core.* required_privileges", async () => {
    const manifest = buildMinimalManifest(["core.something"]);

    await expect(validateManifest(manifest)).rejects.toThrow(
      'Invalid required_privilege "core.something": reserved namespaces core./platform./tenant. are not allowed in app manifests.',
    );
  });

  it("rejects reserved tenant.* required_privileges", async () => {
    const manifest = buildMinimalManifest(["tenant.config.manage"]);

    await expect(validateManifest(manifest)).rejects.toThrow(
      'Invalid required_privilege "tenant.config.manage": reserved namespaces core./platform./tenant. are not allowed in app manifests.',
    );
  });

  it("rejects manifest if any mixed required_privileges item is reserved", async () => {
    const manifest = buildMinimalManifest(["app:vendor.crm:contacts.read", "platform.apps.manage"]);

    await expect(validateManifest(manifest)).rejects.toThrow(
      'Invalid required_privilege "platform.apps.manage": reserved namespaces core./platform./tenant. are not allowed in app manifests.',
    );
  });

  it("accepts non-reserved required_privileges", async () => {
    const manifest = buildMinimalManifest(["hc-app-inventory.items.read"]);

    await expect(validateManifest(manifest)).resolves.toBeUndefined();
  });
});
