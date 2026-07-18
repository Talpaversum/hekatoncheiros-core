alter table core.local_app_projects drop constraint if exists local_app_projects_check;
alter table core.local_app_projects drop constraint if exists local_app_projects_source_type_check;
alter table core.local_app_projects alter column origin_url drop not null;
update core.local_app_projects set source_type='private_feed' where source_type='feed';
alter table core.local_app_projects add constraint local_app_projects_source_type_check
  check (source_type in ('github','gitlab','git','local_workspace','manifest','private_feed'));
alter table core.local_app_projects
  add column if not exists wizard_step integer not null default 1 check (wizard_step between 1 and 10),
  add column if not exists wizard_state_json jsonb not null default '{}'::jsonb;
