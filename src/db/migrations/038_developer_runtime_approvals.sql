alter table core.local_app_projects
  add column if not exists runtime_approval_hash text,
  add column if not exists runtime_approved_by text references core.users(id),
  add column if not exists runtime_approved_at timestamptz;

