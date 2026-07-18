import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { hasPrivilege } from "../../access/privileges.js";
import { recordAudit } from "../../audit/audit-service.js";
import { getPool } from "../../db/pool.js";
import {
  performDeveloperRuntimeAction,
  readDeveloperRuntimeLogs,
  waitForDeveloperRuntimeHealth,
  type DeveloperRuntimePlan,
} from "../../developer/deployment-runtime.js";
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
const activeDeployment = async (request: FastifyRequest, projectId: string) => {
  const result = await getPool().query(
    "select * from core.developer_deployments where tenant_id=$1 and project_id=$2 and is_active",
    [request.requestContext.tenant.tenantId, projectId],
  );
  return result.rows[0] as Record<string, unknown> | undefined;
};
export async function registerDeveloperOperationRoutes(app: FastifyInstance) {
  app.get("/developer-projects/:id/runtime-capabilities", async (request, reply) => {
    await prepare(request, app, "developer.projects.read");
    const row = await project(request, (request.params as { id: string }).id);
    const deployment = await activeDeployment(request, String(row.project_id));
    const plan = deployment?.["runtime_plan_json"] as DeveloperRuntimePlan | undefined;
    const supportedActions =
      plan && (plan.type === "docker_compose" || plan.type === "dockerfile")
        ? ["start", "stop", "restart", "rebuild"]
        : [];
    return reply.send({ supported_actions: supportedActions });
  });
  app.get("/developer-deployments", async (request, reply) => {
    await prepare(request, app, "developer.projects.read");
    const query = z.object({ project_id: z.string().optional() }).parse(request.query);
    const rows = await getPool().query(
      "select d.*,p.display_name from core.developer_deployments d join core.local_app_projects p on p.project_id=d.project_id where d.tenant_id=$1 and ($2::text is null or d.project_id=$2) order by d.started_at desc limit 300",
      [request.requestContext.tenant.tenantId, query.project_id ?? null],
    );
    return reply.send({ items: rows.rows });
  });
  app.get("/developer-deployments/:id", async (request, reply) => {
    await prepare(request, app, "developer.projects.read");
    const result = await getPool().query(
      "select d.*,p.display_name from core.developer_deployments d join core.local_app_projects p on p.project_id=d.project_id where d.deployment_id=$1 and d.tenant_id=$2",
      [(request.params as { id: string }).id, request.requestContext.tenant.tenantId],
    );
    if (!result.rowCount) throw new NotFoundError("Deployment not found");
    return reply.send(result.rows[0]);
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
        before_id: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);
    const rows = await getPool().query(
      "select * from core.developer_logs where tenant_id=$1 and ($2::text is null or project_id=$2) and ($3::text is null or deployment_id=$3) and ($4::text is null or category=$4) and ($5::text is null or level=$5) and ($6::bigint is null or log_id<$6) order by log_id desc limit $7",
      [
        request.requestContext.tenant.tenantId,
        query.project_id ?? null,
        query.deployment_id ?? null,
        query.category ?? null,
        query.level ?? null,
        query.before_id ?? null,
        query.download ? 1000 : query.limit,
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
    return reply.send({ items: rows.rows, next_cursor: rows.rows.at(-1)?.log_id ?? null });
  });
  app.get("/developer-projects/:id/runtime/logs", async (request, reply) => {
    await prepare(request, app, "developer.logs.read");
    const id = (request.params as { id: string }).id;
    await project(request, id);
    const deployment = await activeDeployment(request, id);
    const plan = deployment?.["runtime_plan_json"] as DeveloperRuntimePlan | undefined;
    if (!plan) throw new HttpError(409, "Active runtime plan was not found");
    const { tail } = z
      .object({ tail: z.coerce.number().int().min(1).max(2000).default(300) })
      .parse(request.query);
    return reply.type("text/plain; charset=utf-8").send(await readDeveloperRuntimeLogs(plan, tail));
  });
  app.post("/developer-projects/:id/runtime/action", async (request, reply) => {
    await prepare(request, app, "developer.runtime.manage");
    const id = (request.params as { id: string }).id;
    const row = await project(request, id);
    const body = z
      .object({ action: z.enum(["start", "stop", "restart", "rebuild"]) })
      .parse(request.body);
    const deployment = await activeDeployment(request, id);
    const plan = deployment?.["runtime_plan_json"] as DeveloperRuntimePlan | undefined;
    if (!plan || (plan.type !== "docker_compose" && plan.type !== "dockerfile"))
      throw new HttpError(409, "This project does not have a controllable Core-managed runtime");
    const result = await performDeveloperRuntimeAction(plan, body.action);
    if (body.action !== "stop") await waitForDeveloperRuntimeHealth(plan);
    await getPool().query(
      "update core.local_app_projects set runtime_status=$3,updated_at=now() where project_id=$1 and tenant_id=$2",
      [id, request.requestContext.tenant.tenantId, body.action === "stop" ? "stopped" : "healthy"],
    );
    await getPool().query(
      "update core.developer_deployments set runtime_result=$2::jsonb where deployment_id=$1",
      [
        deployment!["deployment_id"],
        JSON.stringify({
          ...result,
          last_action: body.action,
          action_at: new Date().toISOString(),
        }),
      ],
    );
    await appendDeveloperLog({
      tenantId: request.requestContext.tenant.tenantId,
      projectId: id,
      deploymentId: String(deployment!["deployment_id"]),
      category: "runtime",
      level: "info",
      message: `Runtime ${body.action} completed`,
    });
    await recordAudit({
      tenantId: request.requestContext.tenant.tenantId,
      actorUserId: request.requestContext.actor.userId,
      effectiveUserId: request.requestContext.actor.effectiveUserId,
      action: `developer.runtime.${body.action}`,
      objectRef: id,
      metadata: { app_id: row.installed_app_id },
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
