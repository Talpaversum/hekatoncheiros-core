import type { FastifyInstance } from "fastify";

import { acknowledgeEvents, consumeEvents, publishEvent } from "../../events/event-service.js";
import { requireAppAuth } from "../plugins/auth-app.js";

export async function registerEventRoutes(app: FastifyInstance) {
  app.post("/events/publish", async (request, reply) => {
    const config = app.config;
    await requireAppAuth(request, config);
    const tenantId = request.requestContext.tenant.tenantId;
    const appId = request.requestContext.actor.appId ?? "unknown";
    const body = request.body as { type: string; payload: Record<string, unknown> };
    const result = await publishEvent({
      tenantId,
      sourceAppId: appId,
      type: body.type,
      payload: body.payload ?? {},
    });
    return reply.send(result);
  });

  app.post("/events/consume", async (request, reply) => {
    const config = app.config;
    await requireAppAuth(request, config);
    const tenantId = request.requestContext.tenant.tenantId;
    const appId = request.requestContext.actor.appId ?? "unknown";
    const body = request.body as { consumer_app_id: string; max: number };
    const result = await consumeEvents({
      tenantId,
      consumerAppId: body.consumer_app_id ?? appId,
      max: body.max ?? 50,
    });
    return reply.send(result);
  });

  app.post("/events/ack", async (request, reply) => {
    const config = app.config;
    await requireAppAuth(request, config);
    const tenantId = request.requestContext.tenant.tenantId;
    const appId = request.requestContext.actor.appId ?? "unknown";
    const body = request.body as { consumer_app_id: string; event_ids: string[] };
    await acknowledgeEvents({
      tenantId,
      consumerAppId: body.consumer_app_id ?? appId,
      eventIds: body.event_ids ?? [],
    });
    return reply.code(204).send();
  });
}
