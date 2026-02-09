create table if not exists core.tenant_app_selection (
  tenant_id text not null,
  app_id text not null,
  selected_entitlement_id uuid not null references core.tenant_app_entitlements(id) on delete cascade,
  selected_at timestamptz not null default now(),
  primary key (tenant_id, app_id)
);
