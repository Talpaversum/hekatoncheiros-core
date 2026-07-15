export type PrivilegeScope = "platform" | "tenant";

export type PrivilegeDefinition = {
  id: string;
  label: string;
  description: string;
  scope: PrivilegeScope;
};

export const PRIVILEGE_CATALOG: PrivilegeDefinition[] = [
  {
    id: "platform.superadmin",
    label: "Platform superadmin",
    description: "Full platform administration, including users, tenants, RBAC, and platform policy.",
    scope: "platform",
  },
  {
    id: "platform.apps.manage",
    label: "Manage platform apps",
    description: "Install, publish, and manage app catalog/runtime records across the platform.",
    scope: "platform",
  },
  {
    id: "platform.apps.runtime.manage",
    label: "Manage app runtime",
    description: "Start, stop, and operate app runtime bundles.",
    scope: "platform",
  },
  {
    id: "platform.authors.manage",
    label: "Manage application authors",
    description: "Onboard authors and manage their registry-backed public signing keys.",
    scope: "platform",
  },
  {
    id: "tenant.config.manage",
    label: "Manage tenant configuration",
    description: "Update tenant details and manage tenant-local configuration.",
    scope: "tenant",
  },
  {
    id: "core.apps.register",
    label: "Register apps",
    description: "Register app manifests with Core.",
    scope: "tenant",
  },
  {
    id: "core.apps.enable",
    label: "Enable apps",
    description: "Enable registered apps for a tenant.",
    scope: "tenant",
  },
  {
    id: "core.apps.disable",
    label: "Disable apps",
    description: "Disable apps for a tenant.",
    scope: "tenant",
  },
  {
    id: "core.licensing.read",
    label: "Read licensing",
    description: "View tenant licensing and entitlement state.",
    scope: "tenant",
  },
  {
    id: "core.licensing.ingest_offline",
    label: "Import offline licenses",
    description: "Import offline license tokens for a tenant.",
    scope: "tenant",
  },
  {
    id: "core.licensing.manage_selection",
    label: "Manage license selection",
    description: "Select active licenses for tenant app usage.",
    scope: "tenant",
  },
  {
    id: "core.audit.append",
    label: "Append audit events",
    description: "Write tenant-scoped audit events.",
    scope: "tenant",
  },
  {
    id: "core.audit.read.own",
    label: "Read own audit events",
    description: "Read user-visible audit events related to the current user.",
    scope: "tenant",
  },
  {
    id: "core.audit.read.tenant",
    label: "Read tenant audit events",
    description: "Read user and tenant-admin audit events in the current tenant.",
    scope: "tenant",
  },
  {
    id: "platform.audit.read",
    label: "Read platform audit events",
    description: "Read all platform and tenant audit events.",
    scope: "platform",
  },
  {
    id: "platform.audit.retention.manage",
    label: "Manage audit retention",
    description: "Run and configure audit retention maintenance.",
    scope: "platform",
  },
];

export function findPrivilegeDefinition(id: string) {
  return PRIVILEGE_CATALOG.find((item) => item.id === id);
}

export function tenantScopedPrivileges() {
  return PRIVILEGE_CATALOG.filter((item) => item.scope === "tenant");
}
