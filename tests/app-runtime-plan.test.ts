import { describe, expect, it } from "vitest";

import {
  assertComposeRuntimePlan,
  buildAppRuntimeDeploymentPlan,
} from "../src/apps/app-runtime-plan.js";

describe("app runtime deployment plans", () => {
  it("builds a safe compose plan from catalog deployment metadata", () => {
    const plan = buildAppRuntimeDeploymentPlan({
      app_id: "talpaversum/inventory",
      slug: "inventory",
      base_url: "http://inventory:4010",
      deployment: {
        type: "compose",
        service_name: "inventory",
        internal_base_url: "http://inventory:4010",
        package_url: "https://apps.example/packages/inventory-0.1.0.tar.gz",
        package_sha256: "A".repeat(64),
        compose_project: "hekatoncheiros-core",
        compose_file: "docker-compose.app.yml",
        ports: ["4010:4010"],
        volumes: ["./data:/data"],
      },
    });

    expect(plan).toMatchObject({
      app_id: "talpaversum/inventory",
      mode: "compose",
      service_name: "inventory",
      internal_base_url: "http://inventory:4010",
      package_url: "https://apps.example/packages/inventory-0.1.0.tar.gz",
      package_sha256: "a".repeat(64),
      compose_project: "hekatoncheiros-core",
      compose_file: "docker-compose.app.yml",
      published_ports_allowed: false,
      host_mounts_allowed: false,
      requires_approval: true,
      policy: {
        allow_published_ports: false,
        allow_host_mounts: false,
        allow_custom_networks: false,
        allow_privileged_containers: false,
      },
    });
    expect(plan.warnings).toEqual([
      "ports is ignored by Core runtime policy",
      "volumes is ignored by Core runtime policy",
    ]);
    expect(() => assertComposeRuntimePlan(plan)).not.toThrow();
  });

  it("rejects compose internal URLs that do not point at the service", () => {
    expect(() =>
      buildAppRuntimeDeploymentPlan({
        app_id: "talpaversum/inventory",
        slug: "inventory",
        base_url: "http://inventory:4010",
        deployment: {
          type: "compose",
          service_name: "inventory",
          internal_base_url: "http://other-service:4010",
          package_url: "https://apps.example/packages/inventory-0.1.0.tar.gz",
        },
      }),
    ).toThrow("compose internal_base_url host must match service_name");
  });

  it("rejects unsafe compose file names", () => {
    expect(() =>
      buildAppRuntimeDeploymentPlan({
        app_id: "talpaversum/inventory",
        slug: "inventory",
        base_url: "http://inventory:4010",
        deployment: {
          type: "compose",
          service_name: "inventory",
          internal_base_url: "http://inventory:4010",
          package_url: "https://apps.example/packages/inventory-0.1.0.tar.gz",
          compose_file: "../docker-compose.yml",
        },
      }),
    ).toThrow("compose_file must be a simple relative .yml/.yaml file name");
  });

  it("keeps external entries out of the compose runtime path", () => {
    const plan = buildAppRuntimeDeploymentPlan({
      app_id: "talpaversum/inventory",
      slug: "inventory",
      base_url: "https://inventory.example",
      deployment: {
        type: "external",
      },
    });

    expect(plan.mode).toBe("external");
    expect(plan.requires_approval).toBe(false);
    expect(() => assertComposeRuntimePlan(plan)).toThrow(
      "catalog entry does not include compose deployment metadata",
    );
  });

  it("requires a package URL for compose deployments", () => {
    expect(() =>
      buildAppRuntimeDeploymentPlan({
        app_id: "talpaversum/inventory",
        slug: "inventory",
        base_url: "http://inventory:4010",
        deployment: {
          type: "compose",
          service_name: "inventory",
          internal_base_url: "http://inventory:4010",
        },
      }),
    ).toThrow("compose deployment requires package_url");
  });

  it("rejects package URLs with credentials", () => {
    expect(() =>
      buildAppRuntimeDeploymentPlan({
        app_id: "talpaversum/inventory",
        slug: "inventory",
        base_url: "http://inventory:4010",
        deployment: {
          type: "compose",
          service_name: "inventory",
          internal_base_url: "http://inventory:4010",
          package_url: "https://user:password@apps.example/inventory.tar.gz",
        },
      }),
    ).toThrow("package_url must not include credentials");
  });

  it("rejects invalid package hashes", () => {
    expect(() =>
      buildAppRuntimeDeploymentPlan({
        app_id: "talpaversum/inventory",
        slug: "inventory",
        base_url: "http://inventory:4010",
        deployment: {
          type: "compose",
          service_name: "inventory",
          internal_base_url: "http://inventory:4010",
          package_url: "https://apps.example/inventory.tar.gz",
          package_sha256: "not-a-sha",
        },
      }),
    ).toThrow("package_sha256 must be a SHA-256 hex digest");
  });
});
