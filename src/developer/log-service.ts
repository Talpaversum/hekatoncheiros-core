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
      sanitizeDeveloperLog(input.message),
      JSON.stringify(input.context ?? {}),
    ],
  );
}
