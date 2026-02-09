export interface OnlineEntitlementInput {
  tenant_id: string;
  app_id: string;
  tier: string;
  valid_from: string;
  valid_to: string;
  limits?: Record<string, unknown>;
}

export interface OnlineLicensingProvider {
  fetchEntitlements(tenantId: string): Promise<OnlineEntitlementInput[]>;
}

export class StubOnlineLicensingProvider implements OnlineLicensingProvider {
  async fetchEntitlements(_tenantId: string): Promise<OnlineEntitlementInput[]> {
    return [];
  }
}
