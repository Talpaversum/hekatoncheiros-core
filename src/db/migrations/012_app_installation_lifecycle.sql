create table if not exists core.app_installations (
  tenant_id text not null,
  app_id text not null,
  state text not null,
  error_message text,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, app_id)
);

create table if not exists core.app_db_roles (
  tenant_id text not null,
  app_id text not null,
  role_name text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, app_id)
);
