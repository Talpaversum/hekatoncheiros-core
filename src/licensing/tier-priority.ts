export const TIER_PRIORITY: Record<string, number> = {
  free: 0,
  trial: 1,
  standard: 2,
  enterprise: 3,
};

export function getTierPriority(tier: string): number {
  return TIER_PRIORITY[tier] ?? -1;
}
