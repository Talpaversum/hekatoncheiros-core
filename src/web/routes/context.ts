import type { FastifyInstance } from "fastify";

import { loadPrivilegesForUser } from "../../access/privilege-evaluator.js";
import { getPool } from "../../db/pool.js";
import { requireUserAuth } from "../plugins/auth-user.js";

export async function registerContextRoutes(app: FastifyInstance) {
  app.get("/context", async (request, reply) => {
    const config = app.config;
    await requireUserAuth(request, config);

    const tenantId = request.requestContext.tenant?.tenantId ?? null;
    const actor = request.requestContext.actor;
    const pool = getPool();

    const privileges = await loadPrivilegesForUser(actor.userId, tenantId);
    request.requestContext.privileges = privileges;
    const [userResult, tenantResult] = await Promise.all([
      pool.query("select email, display_name, status, preferred_locale from core.users where id = $1", [actor.userId]),
      tenantId
        ? pool.query("select name, primary_domain, status from core.tenants where id = $1", [tenantId])
        : Promise.resolve({ rows: [], rowCount: 0 }),
    ]);
    const user = userResult.rows[0] as { email?: string; display_name?: string | null; status?: string; preferred_locale?: string } | undefined;
    const tenant = tenantResult.rows[0] as { name?: string; primary_domain?: string | null; status?: string } | undefined;

    return reply.send({
      tenant: {
        id: tenantId,
        mode: request.requestContext.tenant.mode,
        name: tenant?.name ?? null,
        primary_domain: tenant?.primary_domain ?? null,
        status: tenant?.status ?? null,
      },
      actor: {
        user_id: actor.userId,
        email: user?.email ?? null,
        display_name: user?.display_name ?? null,
        status: user?.status ?? null,
        preferred_locale: user?.preferred_locale ?? "en",
        effective_user_id: actor.effectiveUserId,
        impersonating: actor.impersonating,
        delegation: actor.delegation,
      },
      privileges,
      licenses: {},
    });
  });
}
