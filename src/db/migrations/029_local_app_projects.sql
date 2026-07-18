create table if not exists core.local_app_projects (
  project_id text primary key,
  tenant_id text not null references core.tenants(id) on delete cascade,
  created_by text not null references core.users(id),
  display_name text not null,
  origin_url text not null,
  source_type text not null check (source_type in ('manifest','feed')),
  manifest_url text,
  feed_url text,
  status text not null default 'draft' check (status in ('draft','connectivity_failed','connectivity_ok','origin_trusted','source_invalid','source_valid','installed')),
  connectivity_result_json jsonb,
  manifest_result_json jsonb,
  trusted_origin_id uuid references core.trusted_origins(id) on delete set null,
  installed_app_id text references core.installed_apps(app_id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (source_type = 'manifest' and manifest_url is not null and feed_url is null) or
    (source_type = 'feed' and feed_url is not null and manifest_url is null)
  )
);

create index if not exists local_app_projects_tenant_idx
  on core.local_app_projects(tenant_id, updated_at desc);
