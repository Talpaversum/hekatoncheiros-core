create table if not exists core.installed_apps (
  app_id text primary key,
  slug text not null unique,
  app_name text,
  base_url text not null,
  ui_url text not null,
  ui_integrity text not null,
  required_privileges text[] not null default '{}',
  nav_entries jsonb,
  manifest_json jsonb not null,
  enabled boolean not null default true,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
