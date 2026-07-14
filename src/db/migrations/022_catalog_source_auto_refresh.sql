alter table core.app_catalog_sources
  add column if not exists auto_refresh_enabled boolean not null default false;
