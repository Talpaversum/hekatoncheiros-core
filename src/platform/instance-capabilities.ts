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
    const registry = name === "officialAuthorOnboarding" || name === "officialAuthorRegistry" || name === "officialCatalogPublishing" || name === "officialCatalogReview" || name === "externalTrustedAuthorPublishing";
    const configured = !registry || Boolean(config.AUTHOR_REGISTRY_URL);
    return [name, { enabled, configured, available: enabled && configured, ...(!enabled ? { reason: "Capability is disabled on this instance" } : !configured ? { reason: "Author Registry is not configured for this instance" } : {}), ...(registry && config.AUTHOR_REGISTRY_URL ? { url: config.AUTHOR_REGISTRY_URL } : {}) }];
  })) as InstanceCapabilities;
}

export function requireInstanceCapability(config: EnvConfig, name: InstanceCapabilityName) {
  const capability = resolveInstanceCapabilities(config)[name];
  if (!capability.enabled) throw new HttpError(404, capability.reason ?? "Capability is not available", { code: name.startsWith("officialCatalog") ? "official_catalog_not_available" : name.startsWith("official") ? "official_registry_not_available" : "capability_not_available", capability: name });
  if (!capability.configured) throw new HttpError(503, capability.reason ?? "Capability is not configured", { code: "capability_not_configured", capability: name });
  return capability;
}
