create table if not exists core.developer_connections (
  connection_id text primary key,
  tenant_id text not null references core.tenants(id) on delete cascade,
  created_by text not null references core.users(id),
  provider text not null check (provider in ('github','gitlab','git','local_workspace','private_feed')),
  auth_method text not null,
  owner_label text not null,
  status text not null default 'pending' check (status in ('pending','verified','error','revoked')),
  scopes_json jsonb not null default '[]'::jsonb,
  metadata_json jsonb not null default '{}'::jsonb,
  credential_ciphertext text,
  credential_iv text,
  credential_tag text,
  last_used_at timestamptz,
  last_verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists developer_connections_tenant_idx on core.developer_connections(tenant_id,updated_at desc);
alter table core.local_app_projects drop constraint if exists local_app_projects_source_connection_id_fkey;
alter table core.local_app_projects add constraint local_app_projects_source_connection_id_fkey foreign key(source_connection_id) references core.developer_connections(connection_id) on delete set null;
