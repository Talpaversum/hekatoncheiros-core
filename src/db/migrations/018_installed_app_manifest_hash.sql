alter table core.installed_apps
  add column if not exists manifest_hash text;
