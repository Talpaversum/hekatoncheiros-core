create or replace function core.map_legacy_app_id(input_app_id text)
returns text
language sql
immutable
as $$
  select case
    when input_app_id ~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$' then lower(input_app_id)
    when input_app_id ~ '^com\.[a-z0-9_.-]+\.[a-z0-9_.-]+(\.[a-z0-9_.-]+)*$'
      then split_part(lower(input_app_id), '.', 2) || '/' || split_part(lower(input_app_id), '.', array_length(string_to_array(lower(input_app_id), '.'), 1))
    when input_app_id ~ '^hc-app-[a-z0-9_.-]+$' then 'talpaversum/' || substring(lower(input_app_id) from 8)
    when input_app_id ~ '^[a-z0-9_.-]+$' then 'talpaversum/' || lower(input_app_id)
    else input_app_id
  end;
$$;

do $$
declare
  unsupported text;
begin
  with ids as (
    select app_id as value from core.apps
    union
    select app_id as value from core.app_versions
    union
    select app_id as value from core.tenant_apps
    union
    select app_id as value from core.licenses
    union
    select app_id as value from core.installed_apps
    union
    select app_id as value from core.tenant_app_entitlements
    union
    select app_id as value from core.tenant_app_selection
    union
    select app_id as value from core.offline_license_tokens
    union
    select source_app_id as value from core.events
    union
    select consumer_app_id as value from core.event_consumption
    union
    select app_id as value from core.app_migrations
  ), bad as (
    select distinct value
    from ids
    where value is not null
      and value !~ '^[a-z0-9_.-]+/[a-z0-9_.-]+$'
      and value !~ '^com\.[a-z0-9_.-]+\.[a-z0-9_.-]+(\.[a-z0-9_.-]+)*$'
      and value !~ '^hc-app-[a-z0-9_.-]+$'
      and value !~ '^[a-z0-9_.-]+$'
  )
  select string_agg(value, ', ')
    into unsupported
  from bad;

  if unsupported is not null then
    raise exception 'Unsupported legacy app_id formats detected: %', unsupported;
  end if;
end $$;

update core.apps
set app_id = core.map_legacy_app_id(app_id)
where app_id <> core.map_legacy_app_id(app_id);

update core.app_versions
set app_id = core.map_legacy_app_id(app_id),
    manifest_json = jsonb_set(manifest_json, '{app_id}', to_jsonb(core.map_legacy_app_id(coalesce(manifest_json->>'app_id', app_id))), true)
where app_id <> core.map_legacy_app_id(app_id)
   or coalesce(manifest_json->>'app_id', '') <> core.map_legacy_app_id(coalesce(manifest_json->>'app_id', app_id));

update core.tenant_apps
set app_id = core.map_legacy_app_id(app_id)
where app_id <> core.map_legacy_app_id(app_id);

update core.licenses
set app_id = core.map_legacy_app_id(app_id)
where app_id <> core.map_legacy_app_id(app_id);

update core.installed_apps
set app_id = core.map_legacy_app_id(app_id),
    manifest_json = jsonb_set(manifest_json, '{app_id}', to_jsonb(core.map_legacy_app_id(coalesce(manifest_json->>'app_id', app_id))), true)
where app_id <> core.map_legacy_app_id(app_id)
   or coalesce(manifest_json->>'app_id', '') <> core.map_legacy_app_id(coalesce(manifest_json->>'app_id', app_id));

update core.tenant_app_entitlements
set app_id = core.map_legacy_app_id(app_id)
where app_id <> core.map_legacy_app_id(app_id);

update core.tenant_app_selection
set app_id = core.map_legacy_app_id(app_id)
where app_id <> core.map_legacy_app_id(app_id);

update core.offline_license_tokens
set app_id = core.map_legacy_app_id(app_id)
where app_id <> core.map_legacy_app_id(app_id);

update core.events
set source_app_id = core.map_legacy_app_id(source_app_id)
where source_app_id <> core.map_legacy_app_id(source_app_id);

update core.event_consumption
set consumer_app_id = core.map_legacy_app_id(consumer_app_id)
where consumer_app_id <> core.map_legacy_app_id(consumer_app_id);

update core.app_migrations
set app_id = core.map_legacy_app_id(app_id)
where app_id <> core.map_legacy_app_id(app_id);

update core.tenant_licenses
set app_id = core.map_legacy_app_id(app_id)
where app_id <> core.map_legacy_app_id(app_id);

update core.tenant_app_license_selection
set app_id = core.map_legacy_app_id(app_id)
where app_id <> core.map_legacy_app_id(app_id);

update core.oauth_connections
set app_id = core.map_legacy_app_id(app_id)
where app_id is not null and app_id <> core.map_legacy_app_id(app_id);
