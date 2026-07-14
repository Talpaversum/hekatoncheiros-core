create table if not exists core.author_onboardings (
  author_id text primary key,
  display_name text not null,
  public_jwks_json jsonb not null,
  author_cert_jws text not null,
  root_kid text,
  registry_url text not null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.author_registry_snapshots (
  registry_url text primary key,
  root_jwks_json jsonb not null,
  revocations_json jsonb not null,
  synced_at timestamptz not null default now(),
  synced_by text
);

