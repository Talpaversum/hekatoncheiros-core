alter table core.author_registry_snapshots
  add column if not exists trust_anchor_json jsonb;

create table if not exists core.license_issuer_revocation_snapshots (
  issuer_url text primary key,
  revocations_json jsonb not null,
  synced_at timestamptz not null default now(),
  synced_by text
);
