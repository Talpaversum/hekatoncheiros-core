import { getPool } from "../db/pool.js";

export function sanitizeDeveloperLog(value: string) {
  return value
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]")
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(authorization|token|password|secret|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [REDACTED]");
}

function sanitizeContext(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeContext);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        /authorization|token|password|secret|private.?key|credential|environment/i.test(key)
          ? "[REDACTED]"
          : sanitizeContext(item),
      ]),
    );
  }
  return typeof value === "string" ? sanitizeDeveloperLog(value) : value;
}
export async function appendDeveloperLog(input: {
  tenantId: string;
  projectId: string;
  deploymentId?: string;
  category: "source_sync" | "build" | "validation" | "installation" | "runtime" | "deployment";
  level: "debug" | "info" | "warning" | "error";
  message: string;
  context?: Record<string, unknown>;
}) {
  await getPool().query(
    "insert into core.developer_logs(tenant_id,project_id,deployment_id,category,level,message,context_json) values($1,$2,$3,$4,$5,$6,$7::jsonb)",
    [
      input.tenantId,
      input.projectId,
      input.deploymentId ?? null,
      input.category,
      input.level,
      sanitizeDeveloperLog(input.message).slice(0, 100_000),
      JSON.stringify(sanitizeContext(input.context ?? {})),
    ],
  );
  await getPool().query(
    `delete from core.developer_logs
      where project_id=$1 and (
        created_at < now() - interval '30 days'
        or log_id in (
          select log_id from core.developer_logs where project_id=$1 order by log_id desc offset 10000
        )
      )`,
    [input.projectId],
  );
}
