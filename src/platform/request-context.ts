export type TenancyMode = "single" | "db_per_tenant" | "row_level";

export interface TenantContext {
  tenantId: string;
  mode: TenancyMode;
}

export interface ActorContext {
  userId: string;
  effectiveUserId: string;
  impersonating: boolean;
  delegation: null | {
    delegationId: string;
    actions: string[];
  };
  type: "user" | "app";
  appId?: string;
}

export interface RequestContext {
  requestId: string;
  tenant: TenantContext;
  actor: ActorContext;
  privileges: string[];
}
