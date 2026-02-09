create extension if not exists pgcrypto;

create table if not exists core.tenant_app_entitlements (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  app_id text not null,
  source text not null,
  tier text not null,
  valid_from timestamptz not null,
  valid_to timestamptz not null,
  limits jsonb not null default '{}'::jsonb,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tenant_app_entitlements_tenant_app_idx
  on core.tenant_app_entitlements (tenant_id, app_id);

create index if not exists tenant_app_entitlements_tenant_app_status_idx
  on core.tenant_app_entitlements (tenant_id, app_id, status);

create unique index if not exists tenant_app_entitlements_offline_natural_uq
  on core.tenant_app_entitlements (tenant_id, app_id, source, tier, valid_from, valid_to)
  where source = 'OFFLINE';
