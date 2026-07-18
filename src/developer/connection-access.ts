import type { FastifyRequest } from "fastify";

import { hasPrivilege } from "../access/privileges.js";
import { getPool } from "../db/pool.js";
import { ForbiddenError, NotFoundError } from "../shared/errors.js";

export type DeveloperConnectionRow = Record<string, unknown>;

export function requireConnectionUse(request: FastifyRequest) {
  if (!hasPrivilege(request.requestContext.privileges, "developer.connections.use")) {
    throw new ForbiddenError();
  }
}

export async function findAccessibleDeveloperConnection(
  request: FastifyRequest,
  connectionId: unknown,
  provider?: string,
) {
  requireConnectionUse(request);
  const result = await getPool().query(
    `select * from core.developer_connections
     where connection_id=$1 and tenant_id=$2 and status='verified'
       and (visibility='tenant' or owner_user_id=$3)
       and ($4::text is null or provider=$4)`,
    [
      connectionId,
      request.requestContext.tenant.tenantId,
      request.requestContext.actor.userId,
      provider ?? null,
    ],
  );
  if (!result.rowCount) throw new NotFoundError("Developer connection not found");
  return result.rows[0] as DeveloperConnectionRow;
}

export function requireConnectionManagement(request: FastifyRequest, row: DeveloperConnectionRow) {
  const privilege =
    row["visibility"] === "tenant"
      ? "developer.connections.shared.manage"
      : "developer.connections.personal.manage";
  if (
    !hasPrivilege(request.requestContext.privileges, privilege) ||
    (row["visibility"] === "personal" &&
      row["owner_user_id"] !== request.requestContext.actor.userId)
  ) {
    throw new ForbiddenError();
  }
}
