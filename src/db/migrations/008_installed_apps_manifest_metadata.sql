alter table core.installed_apps
  add column if not exists app_version text,
  add column if not exists manifest_version text,
  add column if not exists fetched_at timestamptz;

with ranked as (
  select
    ctid,
    row_number() over (
      partition by base_url
      order by updated_at desc, installed_at desc, app_id asc
    ) as rn
  from core.installed_apps
)
delete from core.installed_apps target
using ranked
where target.ctid = ranked.ctid
  and ranked.rn > 1;

create unique index if not exists installed_apps_base_url_uidx on core.installed_apps (base_url);
