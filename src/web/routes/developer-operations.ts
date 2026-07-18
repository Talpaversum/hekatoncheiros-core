import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { stopDockerComposeAppRuntime } from "../../apps/app-runtime-docker-compose.js";
import { getAppRuntimeInstallation } from "../../apps/app-runtime-installation-store.js";
import { getPool } from "../../db/pool.js";
import { appendDeveloperLog } from "../../developer/log-service.js";
import { requireInstanceCapability } from "../../platform/instance-capabilities.js";
import { ForbiddenError, HttpError, NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";
const prepare = async (request: FastifyRequest, app: FastifyInstance, privilege: string) => {
  await requireUserAuth(request, app.config);
  requireInstanceCapability(app.config, "privateAppDevelopment");
  if (!hasPrivilege(request.requestContext.privileges, privilege)) throw new ForbiddenError();
};
const project = async (request: FastifyRequest, id: string) => {
  const result = await getPool().query(
    "select * from core.local_app_projects where project_id=$1 and tenant_id=$2",
    [id, request.requestContext.tenant.tenantId],
  );
  if (!result.rowCount) throw new NotFoundError("Developer project not found");
  return result.rows[0];
};
export async function registerDeveloperOperationRoutes(app: FastifyInstance) {
  app.get("/developer-deployments", async (request, reply) => {
    await prepare(request, app, "developer.projects.read");
    const query = z.object({ project_id: z.string().optional() }).parse(request.query);
    const rows = await getPool().query(
      "select d.*,p.display_name from core.developer_deployments d join core.local_app_projects p on p.project_id=d.project_id where d.tenant_id=$1 and ($2::text is null or d.project_id=$2) order by d.started_at desc limit 300",
      [request.requestContext.tenant.tenantId, query.project_id ?? null],
    );
    return reply.send({ items: rows.rows });
  });
  app.get("/developer-logs", async (request, reply) => {
    await prepare(request, app, "developer.logs.read");
    const query = z
      .object({
        project_id: z.string().optional(),
        deployment_id: z.string().optional(),
        category: z.string().optional(),
        level: z.string().optional(),
        download: z.coerce.boolean().optional(),
      })
      .parse(request.query);
    const rows = await getPool().query(
      "select * from core.developer_logs where tenant_id=$1 and ($2::text is null or project_id=$2) and ($3::text is null or deployment_id=$3) and ($4::text is null or category=$4) and ($5::text is null or level=$5) order by created_at desc limit 1000",
      [
        request.requestContext.tenant.tenantId,
        query.project_id ?? null,
        query.deployment_id ?? null,
        query.category ?? null,
        query.level ?? null,
      ],
    );
    if (query.download) {
      reply
        .header("content-type", "text/plain; charset=utf-8")
        .header("content-disposition", "attachment; filename=developer-logs.txt");
      return reply.send(
        rows.rows
          .map(
            (row) =>
              `${new Date(row.created_at).toISOString()} ${String(row.level).toUpperCase()} [${row.category}] ${row.message}`,
          )
          .join("\n"),
      );
    }
    return reply.send({ items: rows.rows });
  });
  app.post("/developer-projects/:id/runtime/action", async (request, reply) => {
    await prepare(request, app, "developer.runtime.manage");
    const id = (request.params as { id: string }).id;
    const row = await project(request, id);
    const body = z
      .object({ action: z.enum(["start", "stop", "restart", "rebuild"]) })
      .parse(request.body);
    if (row.runtime_type !== "docker_compose" || !row.installed_app_id)
      throw new HttpError(409, "This project does not have a controllable Core-managed runtime");
    if (body.action !== "stop")
      throw new HttpError(409, "The stored runtime plan does not support this action yet");
    const runtime = await getAppRuntimeInstallation(String(row.installed_app_id));
    if (!runtime) throw new HttpError(409, "Core-managed runtime installation was not found");
    const result = await stopDockerComposeAppRuntime({
      config: app.config,
      identity: { compose_project: runtime.compose_project, service_name: runtime.service_name },
    });
    await getPool().query(
      "update core.local_app_projects set runtime_status='stopped',updated_at=now() where project_id=$1 and tenant_id=$2",
      [id, request.requestContext.tenant.tenantId],
    );
    await appendDeveloperLog({
      tenantId: request.requestContext.tenant.tenantId,
      projectId: id,
      category: "runtime",
      level: "info",
      message: `Runtime ${body.action} completed`,
    });
    return reply.send(result);
  });
  app.post("/developer-deployments/:id/rollback", async (request) => {
    await prepare(request, app, "developer.deployments.run");
    const id = (request.params as { id: string }).id;
    const found = await getPool().query(
      "select * from core.developer_deployments where deployment_id=$1 and tenant_id=$2",
      [id, request.requestContext.tenant.tenantId],
    );
    if (!found.rowCount) throw new NotFoundError("Deployment not found");
    throw new HttpError(
      409,
      "Rollback is not supported by this project's current runtime provider",
    );
  });
}
