create extension if not exists pgcrypto;

create table if not exists core.tenant_licenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  author_id text not null,
  app_id text not null,
  jti text not null,
  license_mode text not null,
  audience jsonb not null,
  license_jws text not null,
  author_cert_jws text,
  author_kid text,
  status text not null,
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists tenant_licenses_jti_uidx on core.tenant_licenses (jti);
create index if not exists tenant_licenses_tenant_app_idx on core.tenant_licenses (tenant_id, app_id);
create index if not exists tenant_licenses_tenant_status_idx on core.tenant_licenses (tenant_id, status);
create index if not exists tenant_licenses_author_idx on core.tenant_licenses (author_id);

create table if not exists core.tenant_app_license_selection (
  tenant_id text not null,
  app_id text not null,
  license_jti text not null,
  selected_at timestamptz not null default now(),
  primary key (tenant_id, app_id),
  constraint tenant_app_license_selection_license_jti_fk
    foreign key (license_jti)
    references core.tenant_licenses(jti)
    on delete cascade
);

create table if not exists core.oauth_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  issuer_url text not null,
  author_id text,
  app_id text,
  client_id text not null,
  client_secret_enc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists oauth_connections_issuer_client_uidx on core.oauth_connections (issuer_url, client_id);
create index if not exists oauth_connections_tenant_issuer_idx on core.oauth_connections (tenant_id, issuer_url);

create table if not exists core.license_revocations_local (
  id uuid primary key default gen_random_uuid(),
  type text not null,
  value text not null,
  created_at timestamptz not null default now()
);

create unique index if not exists license_revocations_local_type_value_uidx
  on core.license_revocations_local (type, value);
