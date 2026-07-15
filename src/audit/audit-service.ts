import { getPool } from "../db/pool.js";

export const AUDIT_SCOPES = ["user", "tenant", "platform"] as const;
export const AUDIT_VISIBILITIES = ["user", "tenant_admin", "platform_admin"] as const;
export const AUDIT_SEVERITIES = ["debug", "info", "warning", "error", "critical"] as const;
export const AUDIT_OUTCOMES = ["success", "failure", "denied", "unknown"] as const;
export const AUDIT_ACTOR_TYPES = ["user", "application", "service", "system", "anonymous"] as const;

export type AuditScope = (typeof AUDIT_SCOPES)[number];
export type AuditVisibility = (typeof AUDIT_VISIBILITIES)[number];
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export type AuditEventInput = {
  tenantId: string | null;
  actorUserId?: string | null;
  effectiveUserId?: string | null;
  actorType: AuditActorType;
  applicationId?: string | null;
  sourceService: string;
  eventType: string;
  category: string;
  action: string;
  outcome: AuditOutcome;
  severity: AuditSeverity;
  scope: AuditScope;
  visibility: AuditVisibility;
  resourceType?: string | null;
  resourceId?: string | null;
  objectRef?: string | null;
  message: string;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  occurredAt?: Date;
};

export type LegacyAuditInput = {
  tenantId: string;
  actorUserId: string | null;
  effectiveUserId: string | null;
  action: string;
  objectRef: string;
  metadata: Record<string, unknown>;
};

const sensitiveKey = /password|passphrase|secret|token|authorization|cookie|api[_-]?key|private[_-]?key|client[_-]?secret/i;
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 4096;
const MAX_METADATA_BYTES = 64 * 1024;

function clean(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED]";
  if (typeof value === "string") return value.slice(0, MAX_STRING_LENGTH);
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => clean(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : clean(item, depth + 1),
      ]),
    );
  }
  return value;
}

export function sanitizeAuditMetadata(metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const sanitized = clean(metadata, 0) as Record<string, unknown>;
  const serialized = JSON.stringify(sanitized);
  if (Buffer.byteLength(serialized, "utf8") <= MAX_METADATA_BYTES) return sanitized;
  return { _truncated: true, preview: serialized.slice(0, MAX_STRING_LENGTH) };
}

function isLegacy(input: AuditEventInput | LegacyAuditInput): input is LegacyAuditInput {
  return !("eventType" in input);
}

export function normalizeAuditInput(input: AuditEventInput | LegacyAuditInput): AuditEventInput {
  if (isLegacy(input)) {
    const eventTypes: Record<string, string> = {
      "account.update": "identity.user.updated", "account.password.change": "identity.password.changed",
      "identity.user.create": "identity.user.created", "identity.user.update": "identity.user.updated",
      "identity.user.privileges.replace": "access.role.updated", "tenant.user.privileges.replace": "access.role.updated",
      "identity.tenant.create": "tenant.created", "identity.tenant.update": "tenant.updated",
      "platform.apps.install": "app.runtime.installed", "platform.apps.runtime.update": "app.runtime.started",
      "platform.apps.runtime.stop": "app.runtime.stopped", "platform.apps.runtime.token.rotate": "app.runtime.token_rotated",
      "platform.apps.uninstall": "app.runtime.uninstalled", "platform.instance.update": "platform.configuration.updated",
      "platform.authors.onboard": "author.created", "platform.authors.keys.rotate": "author.trust_rotated",
      "licensing.license.imported": "licensing.license.imported", "licensing.selection.updated": "licensing.selection.updated",
    };
    const platform = input.action.startsWith("platform.");
    const own = input.action.startsWith("account.");
    return {
      ...input,
      tenantId: platform ? null : input.tenantId,
      actorType: input.actorUserId ? "user" : "system",
      sourceService: "core",
      eventType: eventTypes[input.action] ?? input.action,
      category: input.action.split(".")[platform ? 1 : 0] ?? "audit",
      outcome: "unknown",
      severity: "info",
      scope: platform ? "platform" : own ? "user" : "tenant",
      visibility: platform ? "platform_admin" : own ? "user" : "tenant_admin",
      applicationId: typeof input.metadata["app_id"] === "string" ? input.metadata["app_id"] : null,
      resourceType: own ? "user" : null,
      resourceId: own ? input.effectiveUserId ?? input.actorUserId : null,
      message: input.action,
    };
  }
  return input;
}

export function validateAuditEvent(input: AuditEventInput) {
  if ((input.scope === "platform") !== (input.tenantId === null)) {
    throw new Error("Platform events must have no tenant; user and tenant events require a tenant");
  }
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(input.eventType)) throw new Error("Invalid audit event_type");
  if (!/^[a-z][a-z0-9_.-]*$/.test(input.category)) throw new Error("Invalid audit category");
}

export async function recordAudit(raw: AuditEventInput | LegacyAuditInput) {
  const input = normalizeAuditInput(raw);
  validateAuditEvent(input);
  await getPool().query(
    `insert into core.audit_log
      (tenant_id, actor_user_id, effective_user_id, action, object_ref, metadata,
       occurred_at, scope, visibility, category, severity, outcome, actor_type,
       application_id, source_service, event_type, resource_type, resource_id,
       correlation_id, request_id, ip_address, user_agent, message, schema_version)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,1)`,
    [input.tenantId, input.actorUserId ?? null, input.effectiveUserId ?? null, input.action,
      input.objectRef ?? input.resourceId ?? input.eventType, sanitizeAuditMetadata(input.metadata),
      input.occurredAt ?? new Date(), input.scope, input.visibility, input.category, input.severity,
      input.outcome, input.actorType, input.applicationId ?? null, input.sourceService,
      input.eventType, input.resourceType ?? null, input.resourceId ?? null,
      input.correlationId ?? null, input.requestId ?? null, input.ipAddress ?? null,
      input.userAgent?.slice(0, 1024) ?? null, input.message.slice(0, MAX_STRING_LENGTH)],
  );
}
