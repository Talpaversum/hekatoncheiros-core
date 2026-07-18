alter table core.local_app_projects
  add column if not exists source_connection_id text,
  add column if not exists repository text,
  add column if not exists workspace_path text,
  add column if not exists branch text,
  add column if not exists manifest_path text,
  add column if not exists source_revision text,
  add column if not exists validated_revision text,
  add column if not exists deployed_revision text,
  add column if not exists manifest_hash text,
  add column if not exists runtime_type text not null default 'already_running_service',
  add column if not exists deployment_status text not null default 'not_deployed',
  add column if not exists runtime_status text not null default 'stopped',
  add column if not exists update_status text not null default 'validation_required',
  add column if not exists last_sync_at timestamptz,
  add column if not exists last_validation_at timestamptz,
  add column if not exists last_deployment_at timestamptz;

alter table core.local_app_projects drop constraint if exists local_app_projects_runtime_type_check;
alter table core.local_app_projects add constraint local_app_projects_runtime_type_check
  check (runtime_type in ('dockerfile','docker_compose','external_runtime','already_running_service'));
alter table core.local_app_projects drop constraint if exists local_app_projects_update_status_check;
alter table core.local_app_projects add constraint local_app_projects_update_status_check
  check (update_status in ('up_to_date','update_available','validation_required','validation_failed','deployment_required','runtime_approval_required','deployment_failed'));
