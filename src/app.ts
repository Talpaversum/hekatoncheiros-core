import { STATUS_CODES } from "node:http";

import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import fastify from "fastify";
import { ZodError } from "zod";

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
    if (error instanceof ZodError) {
      const fieldErrors = Object.fromEntries(
        error.issues.map((issue) => [issue.path.join("."), issue.message]),
      );
      return reply
        .status(400)
        .send({
          statusCode: 400,
          error: "Bad Request",
          message: "Validation failed",
          field_errors: fieldErrors,
        });
    }
    if (
      typeof error === "object" &&
      error &&
      "code" in error &&
      (error as { code?: string }).code === "23505"
    ) {
      const detail = String((error as { detail?: unknown }).detail ?? "");
      const field = detail.includes("email")
        ? "email"
        : detail.includes("domain")
          ? "primary_domain"
          : "form";
      return reply
        .status(409)
        .send({
          statusCode: 409,
          error: "Conflict",
          message: "A record with this value already exists",
          field_errors: { [field]: "This value is already in use" },
        });
    }
    if (typeof error === "object" && error && "statusCode" in error) {
      const typed = error as { statusCode: number; message: string };
      const details =
        "details" in typed ? (typed as { details?: Record<string, unknown> }).details : undefined;
      return reply
        .status(typed.statusCode)
        .send({
          statusCode: typed.statusCode,
          error: STATUS_CODES[typed.statusCode] ?? "Error",
          message: typed.message,
          ...(details ?? {}),
        });
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
