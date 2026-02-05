import type { FastifyInstance } from "fastify";

import { registerAppRoutes } from "./apps.js";
import { registerInstalledAppRoutes } from "./apps-installed.js";
import { registerAppProxyRoutes } from "./app-proxy.js";
import { registerAppRegistryRoutes } from "./app-registry.js";
import { registerAuthRoutes } from "./auth.js";
import { registerAuditRoutes } from "./audit.js";
import { registerContextRoutes } from "./context.js";
import { registerEventRoutes } from "./events.js";
import { registerHealthRoutes } from "./health.js";
import { registerLicensingRoutes } from "./licensing.js";

export async function registerRoutes(app: FastifyInstance) {
  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerContextRoutes(app);
  await registerLicensingRoutes(app);
  await registerAppRoutes(app);
  await registerInstalledAppRoutes(app);
  await registerAppRegistryRoutes(app);
  await registerAppProxyRoutes(app);
  await registerEventRoutes(app);
  await registerAuditRoutes(app);
}
