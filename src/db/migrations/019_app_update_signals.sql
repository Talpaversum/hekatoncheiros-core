create table if not exists core.app_update_signals (
  app_id text primary key references core.installed_apps(app_id) on delete cascade,
  source text not null default 'app',
  reported_app_version text,
  reported_manifest_hash text,
  reported_manifest_url text,
  note text,
  reported_at timestamptz not null default now(),
  cleared_at timestamptz,
  constraint app_update_signals_source_chk
    check (source in ('app', 'feed', 'manual'))
);

create index if not exists app_update_signals_reported_at_idx
  on core.app_update_signals (reported_at desc);
