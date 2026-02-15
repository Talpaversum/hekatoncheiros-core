import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { getTrustedOriginsStore, normalizeTrustedOrigin } from "../../platform/trusted-origins-store.js";
import { NotFoundError } from "../../shared/errors.js";
import { requireUserAuth } from "../plugins/auth-user.js";
import { requirePlatformConfigManage } from "../guards/platform-config.js";

const createSchema = z.object({
  origin: z.string().trim().min(1),
  note: z.string().trim().max(500).optional().nullable(),
});

const patchSchema = z
  .object({
    is_enabled: z.boolean().optional(),
    note: z.string().trim().max(500).optional().nullable(),
  })
  .refine((value) => value.is_enabled !== undefined || Object.prototype.hasOwnProperty.call(value, "note"), {
    message: "At least one field must be provided",
  });

export async function registerPlatformTrustedOriginsRoutes(app: FastifyInstance) {
  app.get("/platform/trusted-origins", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformConfigManage(request);

    const store = getTrustedOriginsStore();
    const items = await store.list();
    return reply.send({ items });
  });

  app.post("/platform/trusted-origins", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformConfigManage(request);

    const parsed = createSchema.parse(request.body);
    let normalizedOrigin: string;
    try {
      normalizedOrigin = normalizeTrustedOrigin(parsed.origin);
    } catch (error) {
      return reply.code(400).send({ message: (error as Error).message });
    }

    const store = getTrustedOriginsStore();
    try {
      const created = await store.create({
        origin: normalizedOrigin,
        note: parsed.note ?? null,
        createdBy: request.requestContext.actor.userId,
      });
      return reply.code(201).send(created);
    } catch (error) {
      const message = (error as { message?: string }).message ?? "Failed to create trusted origin";
      if (message.includes("trusted_origins_origin_lower_uidx")) {
        return reply.code(409).send({ message: "Origin already exists" });
      }
      throw error;
    }
  });

  app.patch("/platform/trusted-origins/:id", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformConfigManage(request);

    const id = (request.params as { id: string }).id;
    const parsed = patchSchema.parse(request.body);

    const store = getTrustedOriginsStore();
    const updated = await store.update(id, {
      is_enabled: parsed.is_enabled,
      note: Object.prototype.hasOwnProperty.call(parsed, "note") ? (parsed.note ?? null) : undefined,
    });

    if (!updated) {
      throw new NotFoundError("Trusted origin not found");
    }

    return reply.send(updated);
  });

  app.delete("/platform/trusted-origins/:id", async (request, reply) => {
    await requireUserAuth(request, app.config);
    requirePlatformConfigManage(request);

    const id = (request.params as { id: string }).id;
    const store = getTrustedOriginsStore();
    const deleted = await store.delete(id);
    if (!deleted) {
      throw new NotFoundError("Trusted origin not found");
    }

    return reply.code(204).send();
  });
}
