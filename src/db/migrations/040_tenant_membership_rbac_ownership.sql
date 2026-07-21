alter table core.users
  add column if not exists nickname text;

create table if not exists core.tenant_memberships (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references core.tenants(id) on delete cascade,
  user_id text not null references core.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'inactive')),
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create index if not exists tenant_memberships_user_idx
  on core.tenant_memberships(user_id, status);

create table if not exists core.tenant_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references core.tenants(id) on delete cascade,
  key text not null,
  name text not null,
  description text not null default '',
  is_system boolean not null default false,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, key)
);

create index if not exists tenant_roles_tenant_idx
  on core.tenant_roles(tenant_id, name);

create table if not exists core.role_privileges (
  role_id uuid not null references core.tenant_roles(id) on delete cascade,
  privilege_key text not null,
  created_at timestamptz not null default now(),
  primary key (role_id, privilege_key)
);

create table if not exists core.tenant_member_roles (
  tenant_membership_id uuid not null references core.tenant_memberships(id) on delete cascade,
  role_id uuid not null references core.tenant_roles(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (tenant_membership_id, role_id)
);

create index if not exists tenant_member_roles_role_idx
  on core.tenant_member_roles(role_id);

insert into core.tenant_roles (tenant_id, key, name, description, is_system)
select id, role.key, role.name, role.description, true
from core.tenants
cross join (values
  ('tenant_member', 'Tenant member', 'Base membership role. It intentionally grants no administrative privileges.'),
  ('tenant_admin', 'Tenant administrator', 'Manages tenant details, members, roles, and tenant privileges.'),
  ('tenant_auditor', 'Tenant auditor', 'Reads tenant membership, role configuration, and tenant audit events.')
) as role(key, name, description)
on conflict (tenant_id, key) do nothing;

insert into core.role_privileges (role_id, privilege_key)
select role.id, privilege.key
from core.tenant_roles role
cross join (values
  ('tenant.members.read'),
  ('tenant.members.manage'),
  ('tenant.roles.read'),
  ('tenant.roles.manage'),
  ('tenant.privileges.read'),
  ('tenant.privileges.manage'),
  ('tenant.config.manage')
) as privilege(key)
where role.key = 'tenant_admin'
on conflict do nothing;

insert into core.role_privileges (role_id, privilege_key)
select role.id, privilege.key
from core.tenant_roles role
cross join (values
  ('tenant.members.read'),
  ('tenant.roles.read'),
  ('tenant.privileges.read'),
  ('core.audit.read.tenant')
) as privilege(key)
where role.key = 'tenant_auditor'
on conflict do nothing;

insert into core.tenant_memberships (tenant_id, user_id, status)
select distinct grants.tenant_id, grants.user_id, 'active'
from core.user_privileges grants
join core.users users on users.id=grants.user_id
join core.tenants tenants on tenants.id=grants.tenant_id
where grants.tenant_id is not null
on conflict (tenant_id, user_id) do nothing;

insert into core.tenant_member_roles (tenant_membership_id, role_id)
select membership.id, role.id
from core.tenant_memberships membership
join core.tenant_roles role
  on role.tenant_id = membership.tenant_id and role.key = 'tenant_member'
on conflict do nothing;

alter table core.local_app_projects
  add column if not exists owner_type text,
  add column if not exists owner_id text;

update core.local_app_projects
set owner_type = 'tenant', owner_id = tenant_id
where owner_type is null or owner_id is null;

alter table core.local_app_projects
  alter column owner_type set not null,
  alter column owner_id set not null,
  alter column tenant_id drop not null;

alter table core.local_app_projects
  drop constraint if exists local_app_projects_owner_type_check;
alter table core.local_app_projects
  add constraint local_app_projects_owner_type_check check (owner_type in ('user', 'tenant'));
alter table core.local_app_projects
  drop constraint if exists local_app_projects_owner_reference_check;
alter table core.local_app_projects
  add constraint local_app_projects_owner_reference_check check (
    (owner_type = 'tenant' and tenant_id is not null and owner_id = tenant_id) or
    (owner_type = 'user' and tenant_id is null)
  );

create index if not exists local_app_projects_owner_idx
  on core.local_app_projects(owner_type, owner_id, updated_at desc);

alter table core.developer_connections
  add column if not exists owner_type text,
  add column if not exists owner_id text;

update core.developer_connections
set owner_type = 'tenant', owner_id = tenant_id
where owner_type is null or owner_id is null;

alter table core.developer_connections
  alter column owner_type set not null,
  alter column owner_id set not null,
  alter column tenant_id drop not null;

alter table core.developer_connections
  drop constraint if exists developer_connections_owner_type_check;
alter table core.developer_connections
  add constraint developer_connections_owner_type_check check (owner_type in ('user', 'tenant'));
alter table core.developer_connections
  drop constraint if exists developer_connections_owner_reference_check;
alter table core.developer_connections
  add constraint developer_connections_owner_reference_check check (
    (owner_type = 'tenant' and tenant_id is not null and owner_id = tenant_id) or
    (owner_type = 'user' and tenant_id is null)
  );

create index if not exists developer_connections_owner_idx
  on core.developer_connections(owner_type, owner_id, updated_at desc);

alter table core.developer_deployments alter column tenant_id drop not null;
alter table core.developer_logs alter column tenant_id drop not null;
