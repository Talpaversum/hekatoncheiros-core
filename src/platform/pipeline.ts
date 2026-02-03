import type { FastifyInstance } from "fastify";

import type { RequestContext } from "./request-context.js";

import { buildActorContext } from "../web/plugins/auth-app.js";
import { buildUserContext } from "../web/plugins/auth-user.js";
import { resolveTenant } from "../tenancy/tenant-resolver.js";

declare module "fastify" {
  interface FastifyRequest {
    requestContext: RequestContext;
  }
}

export function registerPipeline(app: FastifyInstance) {
  app.decorateRequest("requestContext", null as unknown as RequestContext);

  app.addHook("onRequest", async (request) => {
    request.requestContext = {
      requestId: request.id,
      tenant: {
        tenantId: "",
        mode: "row_level",
      },
      actor: {
        userId: "",
        effectiveUserId: "",
        impersonating: false,
        delegation: null,
        type: "user",
      },
      privileges: [],
    };
  });

  app.addHook("preHandler", async (request) => {
    const actor = buildUserContext(request) ?? buildActorContext(request);
    if (actor) {
      request.requestContext.actor = actor;
    }

    request.requestContext.tenant = await resolveTenant(request);
  });
}
