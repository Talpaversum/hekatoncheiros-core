alter table core.app_catalog_entries
  add column if not exists published boolean not null default false,
  add column if not exists publish_status text not null default 'draft',
  add column if not exists published_at timestamptz,
  add column if not exists published_by text,
  add column if not exists publish_note text;

do $$
begin
  alter table core.app_catalog_entries
    add constraint app_catalog_entries_publish_status_chk
    check (publish_status in ('draft', 'pending', 'published', 'rejected'));
exception
  when duplicate_object then null;
end $$;

create index if not exists app_catalog_entries_published_idx
  on core.app_catalog_entries (published, publish_status);
