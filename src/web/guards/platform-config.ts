import type { FastifyRequest } from "fastify";

import { hasPrivilege } from "../../access/privileges.js";
import { ForbiddenError } from "../../shared/errors.js";

export function requirePlatformConfigManage(request: FastifyRequest) {
  if (!hasPrivilege(request.requestContext.privileges, "platform.superadmin")) {
    throw new ForbiddenError();
  }
}
