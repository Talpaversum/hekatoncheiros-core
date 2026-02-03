import type { FastifyInstance } from "fastify";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/healthz", async (_request, reply) => reply.send({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => reply.send({ status: "ready" }));
}
