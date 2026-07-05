import type { FastifyInstance } from "fastify";

import { registerAccountRoutes } from "./account.js";
import { registerAppCatalogRoutes } from "./app-catalog.js";
import { registerAppEntitlementRoutes } from "./app-entitlement.js";
import { registerAppProxyRoutes } from "./app-proxy.js";
import { registerAppRegistryRoutes } from "./app-registry.js";
import { registerAppUiAssetRoutes } from "./app-ui-assets.js";
import { registerInstalledAppRoutes } from "./apps-installed.js";
import { registerAppRoutes } from "./apps.js";
import { registerAuditRoutes } from "./audit.js";
import { registerAuthRoutes } from "./auth.js";
import { registerConfigurationRoutes } from "./configuration.js";
import { registerContextRoutes } from "./context.js";
import { registerEventRoutes } from "./events.js";
import { registerHealthRoutes } from "./health.js";
import { registerIdentityRoutes } from "./identity.js";
import { registerLicensingRoutes } from "./licensing.js";
import { registerPlatformTrustedOriginsRoutes } from "./platform-trusted-origins.js";

export async function registerRoutes(app: FastifyInstance) {
  await registerHealthRoutes(app);
  await registerAuthRoutes(app);
  await registerAccountRoutes(app);
  await registerContextRoutes(app);
  await registerConfigurationRoutes(app);
  await registerIdentityRoutes(app);
  await registerLicensingRoutes(app);
  await registerPlatformTrustedOriginsRoutes(app);
  await registerAppRoutes(app);
  await registerAppCatalogRoutes(app);
  await registerInstalledAppRoutes(app);
  await registerAppRegistryRoutes(app);
  await registerAppEntitlementRoutes(app);
  await registerAppUiAssetRoutes(app);
  await registerAppProxyRoutes(app);
  await registerEventRoutes(app);
  await registerAuditRoutes(app);
}
