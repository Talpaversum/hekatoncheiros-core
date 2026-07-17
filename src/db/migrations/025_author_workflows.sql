create table if not exists core.author_requests (
  request_id text primary key,
  requester_user_id text not null references core.users(id),
  tenant_id text not null references core.tenants(id),
  requested_display_name text not null,
  legal_name text,
  contact_email text not null,
  website text,
  git_provider_profile text,
  description text not null default '',
  operating_mode text not null check (operating_mode in ('talpaversum_hosted','trusted_self_hosted','private_self_hosted')),
  intended_distribution text not null check (intended_distribution in ('official_catalog','private_catalog','manual')),
  terms_accepted boolean not null default false,
  public_jwks_json jsonb,
  external_issuer_url text,
  status text not null default 'draft' check (status in ('draft','submitted','pending_review','needs_changes','approved','rejected','suspended','revoked')),
  review_notes text,
  author_id text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by text references core.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists author_requests_requester_idx on core.author_requests(requester_user_id, created_at desc);
create index if not exists author_requests_status_idx on core.author_requests(status, created_at desc);

create table if not exists core.author_profiles (
  author_id text primary key,
  display_name text not null,
  legal_name text,
  contact_email text not null,
  website text,
  description text not null default '',
  operating_mode text not null check (operating_mode in ('talpaversum_hosted','trusted_self_hosted','private_self_hosted')),
  owner_tenant_id text not null references core.tenants(id),
  registry_status text not null default 'not_required' check (registry_status in ('not_required','pending','active','suspended','revoked')),
  author_cert_jws text,
  public_jwks_json jsonb,
  external_issuer_url text,
  status text not null default 'active' check (status in ('active','suspended','revoked')),
  created_from_request_id text references core.author_requests(request_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.author_memberships (
  author_id text not null references core.author_profiles(author_id) on delete cascade,
  user_id text not null references core.users(id),
  role text not null check (role in ('owner','manager','developer','licensing','viewer')),
  permissions_json jsonb not null default '[]'::jsonb,
  status text not null default 'active' check (status in ('active','disabled')),
  created_by text references core.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (author_id, user_id)
);

create index if not exists author_memberships_user_idx on core.author_memberships(user_id, status);

create table if not exists core.author_signing_keys (
  key_id text primary key,
  author_id text not null references core.author_profiles(author_id) on delete cascade,
  public_jwk_json jsonb not null,
  private_jwk_ciphertext text,
  private_jwk_iv text,
  private_jwk_tag text,
  custody text not null check (custody in ('talpaversum_managed','author_managed')),
  status text not null default 'active' check (status in ('active','rotated','revoked')),
  created_at timestamptz not null default now()
);

create table if not exists core.author_git_connections (
  connection_id text primary key,
  author_id text not null references core.author_profiles(author_id) on delete cascade,
  provider text not null check (provider in ('github')),
  account_login text not null,
  credential_ciphertext text not null,
  credential_iv text not null,
  credential_tag text not null,
  status text not null default 'active' check (status in ('active','revoked','inaccessible')),
  metadata_json jsonb not null default '{}'::jsonb,
  last_verified_at timestamptz,
  created_by text not null references core.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (author_id, provider, account_login)
);

create table if not exists core.author_apps (
  author_app_id text primary key,
  author_id text not null references core.author_profiles(author_id) on delete cascade,
  app_id text,
  display_name text not null,
  integration_slug text,
  git_connection_id text references core.author_git_connections(connection_id),
  repository_full_name text,
  repository_visibility text check (repository_visibility in ('public','private','unknown')),
  branch text,
  manifest_path text,
  manifest_json jsonb,
  manifest_errors_json jsonb not null default '[]'::jsonb,
  status text not null default 'draft' check (status in ('draft','manifest_invalid','ready_for_review','submitted','approved','rejected','published','runtime_pending','runtime_approved','running','disabled')),
  runtime_management text not null check (runtime_management in ('talpaversum_managed','external','local_private')),
  licensing_management text not null check (licensing_management in ('talpaversum_hosted','external','private_optional')),
  issuer_url text,
  review_notes text,
  created_by text not null references core.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists author_apps_author_idx on core.author_apps(author_id, created_at desc);

create table if not exists core.catalog_submissions (
  submission_id text primary key,
  author_app_id text not null references core.author_apps(author_app_id) on delete cascade,
  author_id text not null references core.author_profiles(author_id) on delete cascade,
  status text not null default 'draft' check (status in ('draft','submitted','pending_review','needs_changes','approved','rejected','published','unpublished')),
  eligibility_json jsonb not null default '{}'::jsonb,
  review_notes text,
  submitted_by text references core.users(id),
  reviewed_by text references core.users(id),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists core.author_workflow_events (
  event_id uuid primary key default gen_random_uuid(),
  author_id text,
  request_id text,
  author_app_id text,
  submission_id text,
  actor_user_id text references core.users(id),
  action text not null,
  from_status text,
  to_status text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists author_workflow_events_author_idx on core.author_workflow_events(author_id, created_at desc);
create index if not exists author_workflow_events_request_idx on core.author_workflow_events(request_id, created_at desc);
