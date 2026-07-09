import { z } from "zod";

type CatalogDeployment = Record<string, unknown>;

export type AppRuntimeDeploymentPlan = {
  app_id: string;
  mode: "external" | "compose";
  service_name: string;
  internal_base_url: string;
  package_url: string | null;
  package_sha256: string | null;
  compose_project: string;
  compose_file: string | null;
  published_ports_allowed: false;
  host_mounts_allowed: false;
  requires_approval: boolean;
  policy: {
    allow_published_ports: false;
    allow_host_mounts: false;
    allow_custom_networks: false;
    allow_privileged_containers: false;
  };
  warnings: string[];
};

export type AppRuntimeDeploymentEntry = {
  app_id: string;
  slug: string;
  base_url: string;
  deployment: CatalogDeployment;
};

const safeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/);

const relativeComposeFileSchema = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-zA-Z0-9_.-]+\.ya?ml$/);

const sha256Schema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{64}$/i)
  .transform((value) => value.toLowerCase());

function readString(source: CatalogDeployment, key: string): string | null {
  const value = source[key];
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function parseSafeName(value: string | null, fallback: string, fieldName: string): string {
  const candidate = value ?? fallback;
  const parsed = safeNameSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(`${fieldName} must be a safe Compose identifier`);
  }

  return parsed.data;
}

function parseComposeFile(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const parsed = relativeComposeFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("compose_file must be a simple relative .yml/.yaml file name");
  }

  return parsed.data;
}

function parsePackageUrl(value: string | null, mode: string): string | null {
  if (!value) {
    if (mode === "compose") {
      throw new Error("compose deployment requires package_url");
    }
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("package_url must be a valid URL");
  }

  if (parsed.username || parsed.password) {
    throw new Error("package_url must not include credentials");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("package_url must use http or https");
  }

  parsed.hash = "";
  return parsed.toString();
}

function parseSha256(value: string | null, fieldName: string): string | null {
  if (!value) {
    return null;
  }

  const parsed = sha256Schema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${fieldName} must be a SHA-256 hex digest`);
  }

  return parsed.data;
}

function parseInternalBaseUrl(
  value: string | null,
  fallback: string,
  serviceName: string,
  mode: string,
): string {
  const candidate = value ?? fallback;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("internal_base_url must be a valid URL");
  }

  if (parsed.username || parsed.password) {
    throw new Error("internal_base_url must not include credentials");
  }

  if (mode === "compose") {
    if (parsed.protocol !== "http:") {
      throw new Error("compose internal_base_url must use http");
    }
    if (parsed.hostname !== serviceName) {
      throw new Error("compose internal_base_url host must match service_name");
    }
  }

  parsed.hash = "";
  return parsed.origin;
}

function buildWarnings(deployment: CatalogDeployment): string[] {
  const blockedKeys = [
    "ports",
    "published_ports",
    "volumes",
    "host_mounts",
    "networks",
    "privileged",
    "cap_add",
  ];
  return blockedKeys
    .filter((key) => Object.hasOwn(deployment, key))
    .map((key) => `${key} is ignored by Core runtime policy`);
}

export function buildAppRuntimeDeploymentPlan(
  entry: AppRuntimeDeploymentEntry,
): AppRuntimeDeploymentPlan {
  const rawMode = readString(entry.deployment, "type") ?? "external";
  const mode = rawMode === "compose" ? "compose" : "external";
  const serviceName = parseSafeName(
    readString(entry.deployment, "service_name"),
    entry.slug,
    "service_name",
  );
  const composeProject = parseSafeName(
    readString(entry.deployment, "compose_project"),
    "hekatoncheiros-core",
    "compose_project",
  );
  const composeFile = parseComposeFile(readString(entry.deployment, "compose_file"));
  const packageUrl = parsePackageUrl(readString(entry.deployment, "package_url"), mode);
  const packageSha256 = parseSha256(
    readString(entry.deployment, "package_sha256"),
    "package_sha256",
  );
  const internalBaseUrl = parseInternalBaseUrl(
    readString(entry.deployment, "internal_base_url"),
    entry.base_url,
    serviceName,
    mode,
  );

  return {
    app_id: entry.app_id,
    mode,
    service_name: serviceName,
    internal_base_url: internalBaseUrl,
    package_url: packageUrl,
    package_sha256: packageSha256,
    compose_project: composeProject,
    compose_file: composeFile,
    published_ports_allowed: false,
    host_mounts_allowed: false,
    requires_approval: mode === "compose",
    policy: {
      allow_published_ports: false,
      allow_host_mounts: false,
      allow_custom_networks: false,
      allow_privileged_containers: false,
    },
    warnings: buildWarnings(entry.deployment),
  };
}

export function assertComposeRuntimePlan(plan: AppRuntimeDeploymentPlan): void {
  if (plan.mode !== "compose") {
    throw new Error("catalog entry does not include compose deployment metadata");
  }
}
