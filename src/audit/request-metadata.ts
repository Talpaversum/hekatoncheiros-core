import type { FastifyRequest } from "fastify";

export function getAuditRequestMetadata(request: FastifyRequest) {
  const requestId = request.id.slice(0, 128);
  const header = request.headers["x-correlation-id"];
  const candidate = (Array.isArray(header) ? header[0] : header)?.trim();
  return {
    requestId,
    correlationId: candidate && candidate.length <= 128 ? candidate : requestId,
    ipAddress: request.ip,
    userAgent: request.headers["user-agent"]?.slice(0, 1024) ?? null,
  };
}
