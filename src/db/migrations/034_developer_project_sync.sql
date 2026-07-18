alter table core.local_app_projects
  add column if not exists synced_manifest_json jsonb,
  add column if not exists pending_diff_json jsonb;
