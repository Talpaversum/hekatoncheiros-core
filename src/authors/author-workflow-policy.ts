export const AUTHOR_OPERATING_MODES = ["talpaversum_hosted", "trusted_self_hosted"] as const;
export type AuthorOperatingMode = (typeof AUTHOR_OPERATING_MODES)[number];

export const AUTHOR_PERMISSIONS = [
  "author.profile.manage",
  "author.members.manage",
  "author.git.manage",
  "author.apps.create",
  "author.apps.read",
  "author.apps.manage",
  "author.apps.submit",
  "author.apps.publish",
  "author.licensing.manage",
  "author.licensing.issue",
  "author.licensing.revoke",
  "author.audit.read",
] as const;
export type AuthorPermission = (typeof AUTHOR_PERMISSIONS)[number];
export type AuthorRole = "owner" | "manager" | "developer" | "licensing" | "viewer";

export const AUTHOR_ROLE_PERMISSIONS: Record<AuthorRole, AuthorPermission[]> = {
  owner: [...AUTHOR_PERMISSIONS],
  manager: ["author.profile.manage", "author.members.manage", "author.git.manage", "author.apps.create", "author.apps.read", "author.apps.manage", "author.apps.submit", "author.apps.publish", "author.licensing.manage", "author.audit.read"],
  developer: ["author.git.manage", "author.apps.create", "author.apps.read", "author.apps.manage", "author.apps.submit", "author.audit.read"],
  licensing: ["author.apps.read", "author.licensing.manage", "author.licensing.issue", "author.licensing.revoke", "author.audit.read"],
  viewer: ["author.apps.read", "author.audit.read"],
};

export function policyForMode(mode: AuthorOperatingMode) {
  if (mode === "talpaversum_hosted") {
    return { registryRequired: true, officialCatalogEligible: true, runtimeManagement: "talpaversum_managed" as const, licensingManagement: "talpaversum_hosted" as const };
  }
  return { registryRequired: true, officialCatalogEligible: true, runtimeManagement: "external" as const, licensingManagement: "external" as const };
}

const requestTransitions: Record<string, string[]> = {
  draft: ["submitted"], submitted: ["pending_review"], pending_review: ["needs_changes", "approved", "rejected"],
  needs_changes: ["draft", "submitted"], approved: ["suspended", "revoked"], suspended: ["approved", "revoked"], rejected: ["draft"], revoked: [],
};
const appTransitions: Record<string, string[]> = {
  draft: ["manifest_invalid", "ready_for_review"], manifest_invalid: ["ready_for_review"], ready_for_review: ["submitted"],
  submitted: ["approved", "rejected"], approved: ["runtime_pending", "published", "disabled"], rejected: ["ready_for_review"],
  runtime_pending: ["runtime_approved", "rejected"], runtime_approved: ["running", "disabled"], running: ["disabled"], published: ["disabled"], disabled: ["approved"],
};
const submissionTransitions: Record<string, string[]> = {
  draft: ["submitted"], submitted: ["pending_review"], pending_review: ["needs_changes", "approved", "rejected"],
  needs_changes: ["draft", "submitted"], approved: ["published", "rejected"], rejected: ["draft"], published: ["unpublished"], unpublished: ["published"],
};

export function assertWorkflowTransition(kind: "request" | "app" | "submission", from: string, to: string): void {
  const transitions = kind === "request" ? requestTransitions : kind === "app" ? appTransitions : submissionTransitions;
  if (!transitions[from]?.includes(to)) throw new Error(`Invalid ${kind} status transition: ${from} -> ${to}`);
}
