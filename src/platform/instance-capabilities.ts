import type { EnvConfig } from "../config/index.js";
import { HttpError } from "../shared/errors.js";

export const INSTANCE_CAPABILITY_NAMES = [
  "privateAppDevelopment", "trustedOrigins", "privateCatalogs",
  "officialAuthorOnboarding", "officialAuthorRegistry", "officialCatalogPublishing", "officialCatalogReview",
  "hostedAuthorServices", "hostedBuilds", "hostedRuntime", "hostedLicensing", "externalTrustedAuthorPublishing",
] as const;
export type InstanceCapabilityName = typeof INSTANCE_CAPABILITY_NAMES[number];
export type InstanceCapability = { enabled: boolean; configured: boolean; available: boolean; reason?: string; url?: string };
export type InstanceCapabilities = Record<InstanceCapabilityName, InstanceCapability>;

const privateEnabled = new Set<InstanceCapabilityName>(["privateAppDevelopment", "trustedOrigins", "privateCatalogs"]);

export function resolveInstanceCapabilities(config: EnvConfig): InstanceCapabilities {
  let overrides: Partial<Record<InstanceCapabilityName, boolean>> = {};
  try { overrides = JSON.parse(config.INSTANCE_CAPABILITIES_JSON) as typeof overrides; } catch { overrides = {}; }
  return Object.fromEntries(INSTANCE_CAPABILITY_NAMES.map((name) => {
    const enabled = overrides[name] ?? privateEnabled.has(name);
    const requirements: Partial<Record<InstanceCapabilityName, Array<[boolean, string]>>> = {
      officialAuthorOnboarding: [[Boolean(config.AUTHOR_REGISTRY_URL), "Author Registry URL is missing"], [Boolean(config.AUTHOR_REGISTRY_SERVICE_TOKEN), "Registry service identity is missing"], [Boolean(config.AUTHOR_REGISTRY_TRUSTED_JWKS_JSON), "Trusted registry identity is missing"]],
      officialAuthorRegistry: [[Boolean(config.AUTHOR_REGISTRY_URL), "Author Registry URL is missing"], [Boolean(config.AUTHOR_REGISTRY_SERVICE_TOKEN), "Registry service identity is missing"], [Boolean(config.AUTHOR_REGISTRY_TRUSTED_JWKS_JSON), "Trusted registry identity is missing"]],
      officialCatalogPublishing: [[Boolean(config.OFFICIAL_CATALOG_URL), "Official catalog publishing backend is missing"]],
      officialCatalogReview: [[Boolean(config.OFFICIAL_CATALOG_URL), "Official catalog review backend is missing"]],
      hostedBuilds: [[Boolean(config.HOSTED_BUILD_PROVIDER_URL), "Build provider is missing"], [Boolean(config.HOSTED_ARTIFACT_STORAGE_URL), "Artifact storage is missing"]],
      hostedRuntime: [[Boolean(config.HOSTED_RUNTIME_PROVIDER_URL), "Runtime orchestrator is missing"], [config.APP_RUNTIME_DOCKER_ENABLED, "Runtime execution is disabled"]],
      hostedLicensing: [[Boolean(config.HOSTED_LICENSING_ISSUER_URL), "Licensing issuer is missing"], [Boolean(config.HOSTED_LICENSING_SIGNING_KID), "Licensing signing identity is missing"]],
      externalTrustedAuthorPublishing: [[Boolean(config.AUTHOR_REGISTRY_URL), "Author Registry URL is missing"], [Boolean(config.AUTHOR_REGISTRY_TRUSTED_JWKS_JSON), "Trusted registry identity is missing"]],
    };
    const failed = (requirements[name] ?? []).find(([ok]) => !ok);
    const configured = !failed;
    return [name, { enabled, configured, available: enabled && configured, ...(!enabled ? { reason: "Capability is disabled on this instance" } : failed ? { reason: failed[1] } : {}), ...(config.AUTHOR_REGISTRY_URL && name.startsWith("officialAuthor") ? { url: config.AUTHOR_REGISTRY_URL } : {}) }];
  })) as InstanceCapabilities;
}

export function requireInstanceCapability(config: EnvConfig, name: InstanceCapabilityName) {
  const capability = resolveInstanceCapabilities(config)[name];
  if (!capability.enabled) throw new HttpError(404, capability.reason ?? "Capability is not available", { code: name === "hostedRuntime" ? "hosted_runtime_not_available" : name.startsWith("officialCatalog") ? "official_catalog_not_available" : name.startsWith("official") ? "official_registry_not_available" : "capability_not_available", capability: name });
  if (!capability.configured) throw new HttpError(503, capability.reason ?? "Capability is not configured", { code: "capability_not_configured", capability: name });
  return capability;
}
