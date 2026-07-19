create table if not exists core.app_runtime_health_results (
  app_id text primary key references core.installed_apps(app_id) on delete cascade,
  runtime_health text not null check (runtime_health in ('unknown','healthy','degraded','unreachable','stopped')),
  checked_at timestamptz,
  url text,
  http_status integer,
  reported_status text,
  latency_ms integer,
  error_code text,
  error_message text,
  consecutive_failures integer not null default 0,
  last_healthy_at timestamptz,
  status_changed_at timestamptz not null default now()
);
