create or replace function core.default_developer_owner()
returns trigger
language plpgsql
as $$
begin
  if new.owner_type is null then
    new.owner_type := case when new.tenant_id is null then 'user' else 'tenant' end;
  end if;
  if new.owner_id is null then
    new.owner_id := case when new.owner_type = 'user' then new.created_by else new.tenant_id end;
  end if;
  return new;
end;
$$;

drop trigger if exists local_app_projects_default_owner on core.local_app_projects;
create trigger local_app_projects_default_owner
before insert on core.local_app_projects
for each row execute function core.default_developer_owner();

drop trigger if exists developer_connections_default_owner on core.developer_connections;
create trigger developer_connections_default_owner
before insert on core.developer_connections
for each row execute function core.default_developer_owner();
