alter table core.users
  add column if not exists display_name text,
  add column if not exists updated_at timestamptz not null default now();

alter table core.tenants
  add column if not exists updated_at timestamptz not null default now();

alter table core.platform_instance
  add column if not exists name text not null default 'Hekatoncheiros Core',
  add column if not exists public_base_url text,
  add column if not exists updated_at timestamptz not null default now();
