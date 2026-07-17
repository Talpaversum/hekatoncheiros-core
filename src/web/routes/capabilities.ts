import type { FastifyInstance } from "fastify";

import { resolveInstanceCapabilities } from "../../platform/instance-capabilities.js";
import { requireUserAuth } from "../plugins/auth-user.js";

export async function registerCapabilityRoutes(app: FastifyInstance) {
  app.get("/platform/capabilities", async (request, reply) => {
    await requireUserAuth(request, app.config);
    return reply.send(resolveInstanceCapabilities(app.config));
  });
}
