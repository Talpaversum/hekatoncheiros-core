import { SignJWT, importJWK, type JWK } from "jose";

import type { EnvConfig } from "../config/index.js";
import type { RequestContext } from "../platform/request-context.js";

export const APP_USER_DELEGATION_TTL_SECONDS = 60;

export async function issueAppUserDelegation(params: {
  appId: string;
  context: RequestContext;
  username: string;
  correlationId: string;
  config: EnvConfig;
  authorScope?: {
    authorId: string;
    permissions: string[];
    operatorScope?: string[];
  };
}) {
  const now = Math.floor(Date.now() / 1000);
  if (!params.config.APP_DELEGATION_SIGNING_PRIVATE_JWK_JSON) {
    throw new Error("APP_DELEGATION_SIGNING_PRIVATE_JWK_JSON is not configured");
  }
  const privateJwk = JSON.parse(params.config.APP_DELEGATION_SIGNING_PRIVATE_JWK_JSON) as JWK;
  const key = await importJWK(privateJwk, "EdDSA");
  return new SignJWT({
    typ: "hc-user-delegation",
    app_id: params.appId,
    tenant_id: params.context.tenant.tenantId,
    username: params.username,
    effective_user_id: params.context.actor.effectiveUserId,
    impersonating: params.context.actor.impersonating,
    privileges: params.context.privileges,
    ...(params.authorScope ? {
      author_id: params.authorScope.authorId,
      author_permissions: params.authorScope.permissions,
      operator_scope: params.authorScope.operatorScope ?? [],
    } : {}),
    correlation_id: params.correlationId,
  })
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: privateJwk.kid })
    .setSubject(params.context.actor.userId)
    .setIssuer(params.config.JWT_ISSUER)
    .setAudience(`hc-app:${params.appId}`)
    .setIssuedAt(now)
    .setExpirationTime(now + APP_USER_DELEGATION_TTL_SECONDS)
    .sign(key);
}
