import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastify from "fastify";
import { STATUS_CODES } from "node:http";

import { registerCatalogAutoRefresh } from "./apps/app-catalog-auto-refresh.js";
import { registerAppRuntimeHealthMonitor } from "./apps/app-runtime-health.js";
import { loadConfig, type EnvConfig } from "./config/index.js";
import { registerPipeline } from "./platform/pipeline.js";
import { registerAppCatalogPublicRoutes } from "./web/routes/app-catalog.js";
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
  registerCatalogAutoRefresh(app);
  registerAppRuntimeHealthMonitor(app);

  await app.register(cors, {
    origin: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });

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

  app.setErrorHandler((error, _request, reply) => {
    if (typeof error === "object" && error && "statusCode" in error) {
      const typed = error as { statusCode: number; message: string };
      const details = "details" in typed ? (typed as { details?: Record<string, unknown> }).details : undefined;
      return reply.status(typed.statusCode).send({ statusCode: typed.statusCode, error: STATUS_CODES[typed.statusCode] ?? "Error", message: typed.message, ...(details ?? {}) });
    }
    app.log.error(error);
    return reply.status(500).send({ message: "Internal Server Error" });
  });

  registerPipeline(app);
  await registerAppCatalogPublicRoutes(app);
  await app.register(async (instance) => {
    instance.register(registerRoutes, { prefix: "/api/v1" });
  });

  return app;
}
