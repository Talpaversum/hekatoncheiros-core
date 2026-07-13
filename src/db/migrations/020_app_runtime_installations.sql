create table if not exists core.app_runtime_installations (
  app_id text primary key references core.installed_apps(app_id) on delete cascade,
  runtime_type text not null,
  compose_project text not null,
  service_name text not null,
  package_sha256 text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_runtime_installations_type_chk
    check (runtime_type in ('compose'))
);
