alter table core.developer_connections
  add column if not exists visibility text not null default 'personal',
  add column if not exists owner_user_id text references core.users(id);

update core.developer_connections
set owner_user_id=created_by
where owner_user_id is null;

alter table core.developer_connections
  alter column owner_user_id set not null;

alter table core.developer_connections
  drop constraint if exists developer_connections_visibility_check;
alter table core.developer_connections
  add constraint developer_connections_visibility_check
  check (visibility in ('personal','tenant'));

create index if not exists developer_connections_access_idx
  on core.developer_connections(tenant_id,visibility,owner_user_id,updated_at desc);

insert into core.user_privileges(user_id,tenant_id,privilege)
select user_id,tenant_id,new_privilege
from core.user_privileges
cross join (values
  ('developer.connections.personal.manage'),
  ('developer.connections.shared.manage'),
  ('developer.connections.use')
) privileges(new_privilege)
where privilege='developer.connections.manage'
on conflict do nothing;
