alter table core.user_privileges
  add column id bigserial;

update core.user_privileges
set id = nextval(pg_get_serial_sequence('core.user_privileges', 'id'))
where id is null;

alter table core.user_privileges
  drop constraint if exists core_user_privileges_pkey;

alter table core.user_privileges
  drop constraint if exists user_privileges_pkey;

alter table core.user_privileges
  alter column tenant_id drop not null;

alter table core.user_privileges
  alter column id set not null;

alter table core.user_privileges
  add constraint core_user_privileges_pkey primary key (id);

create unique index if not exists user_privileges_user_privilege_tenant_unique_idx
  on core.user_privileges (user_id, privilege, tenant_id);

create unique index if not exists user_privileges_user_privilege_platform_unique_idx
  on core.user_privileges (user_id, privilege)
  where tenant_id is null;

create index if not exists user_privileges_user_tenant_idx
  on core.user_privileges (user_id, tenant_id);
