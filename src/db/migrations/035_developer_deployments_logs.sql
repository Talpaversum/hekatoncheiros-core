create table if not exists core.developer_deployments (
  deployment_id text primary key,
  tenant_id text not null references core.tenants(id) on delete cascade,
  project_id text not null references core.local_app_projects(project_id) on delete cascade,
  source_revision text,
  manifest_hash text,
  status text not null check (status in ('queued','syncing','building','validating','deploying','running','failed','rolled_back','cancelled')),
  started_by text not null references core.users(id),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  build_result jsonb,
  install_result jsonb,
  runtime_result jsonb,
  manifest_snapshot_json jsonb,
  previous_deployment_id text references core.developer_deployments(deployment_id),
  rollback_status text,
  error_message text
);
create index if not exists developer_deployments_tenant_idx on core.developer_deployments(tenant_id,started_at desc);
create table if not exists core.developer_logs (
  log_id bigserial primary key,
  tenant_id text not null references core.tenants(id) on delete cascade,
  project_id text not null references core.local_app_projects(project_id) on delete cascade,
  deployment_id text references core.developer_deployments(deployment_id) on delete cascade,
  category text not null check (category in ('source_sync','build','validation','installation','runtime','deployment')),
  level text not null check (level in ('debug','info','warning','error')),
  message text not null,
  context_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists developer_logs_filter_idx on core.developer_logs(tenant_id,project_id,deployment_id,created_at desc);
