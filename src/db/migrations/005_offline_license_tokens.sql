create table if not exists core.offline_license_tokens (
  id uuid primary key,
  tenant_id text not null,
  app_id text not null,
  kid text not null,
  token_hash text not null,
  claims jsonb not null,
  ingested_at timestamptz not null default now(),
  verification_result text not null,
  last_verified_at timestamptz
);

create index if not exists offline_license_tokens_tenant_app_idx
  on core.offline_license_tokens (tenant_id, app_id);
