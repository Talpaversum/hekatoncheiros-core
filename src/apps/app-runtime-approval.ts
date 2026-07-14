import { recordAudit } from "../audit/audit-service.js";

import type { AppRuntimeDeploymentPlan } from "./app-runtime-plan.js";

export type AppRuntimeStartApproval = {
  confirmed: true;
  expected_manifest_sha256: string;
  expected_package_sha256: string;
  expected_deployment: {
    service_name: string;
    internal_base_url: string;
    package_url: string;
    compose_project: string;
    compose_file: string;
  };
};

export type AppRuntimeApprovalErrorCode =
  | "runtime_approval_required"
  | "runtime_approval_stale";

export class AppRuntimeApprovalError extends Error {
  constructor(
    message: string,
    readonly code: AppRuntimeApprovalErrorCode,
  ) {
    super(message);
    this.name = "AppRuntimeApprovalError";
  }
}

export function assertAppRuntimeStartApproval({
  approval,
  manifestSha256,
  plan,
}: {
  approval?: AppRuntimeStartApproval;
  manifestSha256: string;
  plan: AppRuntimeDeploymentPlan;
}): void {
  if (!approval?.confirmed) {
    throw new AppRuntimeApprovalError(
      "Explicit administrator approval is required to start a Core-managed runtime",
      "runtime_approval_required",
    );
  }

  if (
    approval.expected_manifest_sha256.toLowerCase() !== manifestSha256.toLowerCase() ||
    approval.expected_package_sha256.toLowerCase() !== plan.package_sha256?.toLowerCase() ||
    approval.expected_deployment.service_name !== plan.service_name ||
    approval.expected_deployment.internal_base_url !== plan.internal_base_url ||
    approval.expected_deployment.package_url !== plan.package_url ||
    approval.expected_deployment.compose_project !== plan.compose_project ||
    approval.expected_deployment.compose_file !== plan.compose_file
  ) {
    throw new AppRuntimeApprovalError(
      "The approved deployment has changed; review the current plan and approve it again",
      "runtime_approval_stale",
    );
  }
}

export async function recordAppRuntimeStartApproval({
  tenantId,
  actorUserId,
  effectiveUserId,
  appVersion,
  sourceType,
  trustStatus,
  manifestSha256,
  plan,
  auditWriter = recordAudit,
}: {
  tenantId: string;
  actorUserId: string;
  effectiveUserId: string;
  appVersion: string;
  sourceType: string;
  trustStatus: string;
  manifestSha256: string;
  plan: AppRuntimeDeploymentPlan;
  auditWriter?: typeof recordAudit;
}): Promise<void> {
  await auditWriter({
    tenantId,
    actorUserId,
    effectiveUserId,
    action: "platform.apps.runtime.start.approved",
    objectRef: plan.app_id,
    metadata: {
      manifest_sha256: manifestSha256,
      package_sha256: plan.package_sha256,
      app_version: appVersion,
      source_type: sourceType,
      trust_status: trustStatus,
      deployment: {
        service_name: plan.service_name,
        internal_base_url: plan.internal_base_url,
        package_url: plan.package_url,
        compose_project: plan.compose_project,
        compose_file: plan.compose_file,
        policy: plan.policy,
      },
    },
  });
}
