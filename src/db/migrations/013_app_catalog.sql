create table if not exists core.app_catalog_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source_type text not null,
  feed_url text,
  trust_mode text not null default 'manual',
  is_enabled boolean not null default true,
  last_sync_at timestamptz,
  last_error text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_catalog_sources_source_type_chk
    check (source_type in ('manual', 'feed')),
  constraint app_catalog_sources_trust_mode_chk
    check (trust_mode in ('dev', 'manual', 'verified', 'official'))
);

create unique index if not exists app_catalog_sources_feed_url_uidx
  on core.app_catalog_sources (feed_url)
  where feed_url is not null;

create table if not exists core.app_catalog_entries (
  app_id text primary key,
  source_id uuid references core.app_catalog_sources(id) on delete set null,
  source_type text not null default 'manual',
  trust_status text not null default 'manual',
  author_id text,
  namespace text,
  slug text not null,
  app_name text not null,
  app_version text not null,
  summary text,
  base_url text not null,
  manifest_url text not null,
  manifest_hash text not null,
  manifest_version text not null,
  license_required boolean not null default false,
  license_issuer_url text,
  metadata_json jsonb not null default '{}'::jsonb,
  created_by text,
  fetched_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_catalog_entries_source_type_chk
    check (source_type in ('manual', 'feed')),
  constraint app_catalog_entries_trust_status_chk
    check (trust_status in ('dev', 'manual', 'unverified', 'verified', 'official', 'rejected'))
);

create index if not exists app_catalog_entries_namespace_idx
  on core.app_catalog_entries (namespace);

create index if not exists app_catalog_entries_source_id_idx
  on core.app_catalog_entries (source_id);
