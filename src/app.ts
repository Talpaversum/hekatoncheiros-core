import fastify from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

import { loadConfig, type EnvConfig } from "./config/index.js";
import { registerPipeline } from "./platform/pipeline.js";
import { registerRoutes } from "./web/routes/index.js";

declare module "fastify" {
  interface FastifyInstance {
    config: EnvConfig;
  }
}

export async function buildApp() {
  const config = loadConfig();
  const app = fastify({ logger: true });
  app.decorate("config", config);

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Hekatoncheiros Core API",
        version: "0.1.1",
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  registerPipeline(app);
  await app.register(async (instance) => {
    instance.register(registerRoutes, { prefix: "/api/v1" });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (typeof error === "object" && error && "statusCode" in error) {
      const typed = error as { statusCode: number; message: string };
      return reply.status(typed.statusCode).send({ message: typed.message });
    }
    app.log.error(error);
    return reply.status(500).send({ message: "Internal Server Error" });
  });

  return app;
}
