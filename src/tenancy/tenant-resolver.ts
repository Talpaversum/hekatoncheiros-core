import type { FastifyRequest } from "fastify";

import type { EnvConfig } from "../config/index.js";
import type { TenantContext } from "../platform/request-context.js";

import { loadConfig } from "../config/index.js";

export interface TenantResolver {
  resolve(request: FastifyRequest, config: EnvConfig): Promise<string | null>;
}

export class HeaderTenantResolver implements TenantResolver {
  async resolve(request: FastifyRequest): Promise<string | null> {
    const header = request.headers["x-tenant-id"];
    if (!header) {
      return null;
    }
    if (Array.isArray(header)) {
      return header[0] ?? null;
    }
    return header;
  }
}

const headerResolver = new HeaderTenantResolver();

export async function resolveTenant(request: FastifyRequest): Promise<TenantContext> {
  const config = loadConfig();
  const resolved = (await headerResolver.resolve(request, config)) ?? config.DEFAULT_TENANT_ID;

  return {
    tenantId: resolved,
    mode: config.TENANCY_MODE,
  };
}
