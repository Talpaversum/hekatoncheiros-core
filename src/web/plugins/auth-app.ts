import type { FastifyRequest } from "fastify";

import { jwtVerify } from "jose";

import type { EnvConfig } from "../../config/index.js";
import type { ActorContext } from "../../platform/request-context.js";

import { UnauthorizedError } from "../../shared/errors.js";

export interface AppClaims {
  sub: string;
  aud: string | string[];
  iss: string;
  app_id: string;
  tenant_id?: string;
}

export async function verifyAppJwt(token: string, config: EnvConfig): Promise<AppClaims> {
  const secret = new TextEncoder().encode(config.JWT_SECRET);
  const { payload } = await jwtVerify(token, secret, {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE_APP,
  });

  return payload as unknown as AppClaims;
}

export function buildActorContext(request: FastifyRequest): ActorContext | null {
  const claims = request.appClaims as AppClaims | undefined;
  if (!claims) {
    return null;
  }

  return {
    userId: claims.sub,
    effectiveUserId: claims.sub,
    impersonating: false,
    delegation: null,
    type: "app",
    appId: claims.app_id,
  };
}

export function registerAppAuth(request: FastifyRequest, claims: AppClaims) {
  request.appClaims = claims;
}

declare module "fastify" {
  interface FastifyRequest {
    appClaims?: AppClaims;
  }
}

export async function requireAppAuth(request: FastifyRequest, config: EnvConfig) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError();
  }

  const token = header.slice("Bearer ".length);
  const claims = await verifyAppJwt(token, config);
  registerAppAuth(request, claims);
  request.requestContext.actor = buildActorContext(request) ?? request.requestContext.actor;
  if (claims.tenant_id) {
    request.requestContext.tenant.tenantId = claims.tenant_id;
  }
}
