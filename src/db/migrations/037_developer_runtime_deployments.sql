alter table core.developer_deployments
  add column if not exists runtime_plan_json jsonb,
  add column if not exists runtime_plan_hash text,
  add column if not exists source_path text,
  add column if not exists error_code text,
  add column if not exists is_active boolean not null default false;

alter table core.app_runtime_installations
  drop constraint if exists app_runtime_installations_type_chk;
alter table core.app_runtime_installations
  add constraint app_runtime_installations_type_chk
  check (runtime_type in ('compose','dockerfile'));

create index if not exists developer_deployments_project_idx
  on core.developer_deployments(tenant_id,project_id,started_at desc);
update core.developer_deployments d set is_active=true
where d.deployment_id in (
  select distinct on (project_id) deployment_id
  from core.developer_deployments
  where status='running'
  order by project_id,started_at desc
);
create unique index if not exists developer_deployments_active_idx
  on core.developer_deployments(project_id) where is_active;
