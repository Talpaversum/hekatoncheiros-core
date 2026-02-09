import type { FastifyRequest } from "fastify";

import { jwtVerify } from "jose";

import type { EnvConfig } from "../../config/index.js";
import type { ActorContext } from "../../platform/request-context.js";

import { loadPrivilegesForUser } from "../../access/privilege-evaluator.js";
import { UnauthorizedError } from "../../shared/errors.js";

export interface UserClaims {
  sub: string;
  aud: string | string[];
  iss: string;
  privileges?: string[];
  tenant_id?: string;
  effective_user_id?: string;
  impersonating?: boolean;
}

export async function verifyUserJwt(token: string, config: EnvConfig): Promise<UserClaims> {
  const secret = new TextEncoder().encode(config.JWT_SECRET);
  const { payload } = await jwtVerify(token, secret, {
    issuer: config.JWT_ISSUER,
    audience: config.JWT_AUDIENCE_USER,
  });

  return payload as unknown as UserClaims;
}

export function buildUserContext(request: FastifyRequest): ActorContext | null {
  const claims = request.userClaims as UserClaims | undefined;
  if (!claims) {
    return null;
  }

  return {
    userId: claims.sub,
    effectiveUserId: claims.effective_user_id ?? claims.sub,
    impersonating: claims.impersonating ?? false,
    delegation: null,
    type: "user",
  };
}

export function registerUserAuth(request: FastifyRequest, claims: UserClaims) {
  request.userClaims = claims;
}

declare module "fastify" {
  interface FastifyRequest {
    userClaims?: UserClaims;
  }
}

export async function requireUserAuth(request: FastifyRequest, config: EnvConfig) {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new UnauthorizedError();
  }

  const token = header.slice("Bearer ".length);
  let claims: UserClaims;
  try {
    claims = await verifyUserJwt(token, config);
  } catch {
    throw new UnauthorizedError();
  }
  registerUserAuth(request, claims);
  request.requestContext.actor = buildUserContext(request) ?? request.requestContext.actor;
  if (claims.tenant_id) {
    request.requestContext.tenant.tenantId = claims.tenant_id;
  }
  const tenantId = request.requestContext.tenant?.tenantId ?? null;
  request.requestContext.privileges = await loadPrivilegesForUser(
    request.requestContext.actor.userId,
    tenantId,
  );
}
