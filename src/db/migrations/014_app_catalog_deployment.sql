alter table core.app_catalog_entries
  add column if not exists deployment_json jsonb not null default '{"type":"external"}'::jsonb;
