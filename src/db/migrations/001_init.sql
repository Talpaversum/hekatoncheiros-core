create schema if not exists core;

create table if not exists core.users (
  id text primary key,
  email text not null,
  password_hash text not null,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

create table if not exists core.refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id text not null references core.users(id),
  token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists refresh_tokens_user_id_idx on core.refresh_tokens (user_id);
create index if not exists refresh_tokens_token_hash_idx on core.refresh_tokens (token_hash);

create table if not exists core.tenants (
  id text primary key,
  name text not null,
  primary_domain text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);


create table if not exists core.user_privileges (
  user_id text not null,
  tenant_id text not null,
  privilege text not null,
  primary key (user_id, tenant_id, privilege)
);

create table if not exists core.apps (
  app_id text primary key,
  vendor text not null,
  latest_version text,
  manifest_hash text,
  created_at timestamptz not null default now()
);

create table if not exists core.app_versions (
  app_id text not null,
  version text not null,
  manifest_json jsonb not null,
  created_at timestamptz not null default now(),
  primary key (app_id, version)
);

create table if not exists core.tenant_apps (
  tenant_id text not null,
  app_id text not null,
  enabled boolean not null default false,
  version_pinned text,
  config jsonb,
  primary key (tenant_id, app_id)
);

create table if not exists core.licenses (
  tenant_id text not null,
  app_id text not null,
  license_blob text,
  signature text,
  status text not null default 'inactive',
  plan text,
  expires_at timestamptz,
  entitlements_json jsonb,
  primary key (tenant_id, app_id)
);

create table if not exists core.events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  source_app_id text not null,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists core.event_consumption (
  consumer_app_id text not null,
  event_id uuid not null,
  tenant_id text not null,
  processed_at timestamptz not null default now(),
  primary key (consumer_app_id, event_id)
);

create table if not exists core.audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  actor_user_id text,
  effective_user_id text,
  action text not null,
  object_ref text not null,
  metadata jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists core.app_migrations (
  app_id text not null,
  version text not null,
  applied_at timestamptz not null default now(),
  primary key (app_id, version)
);
