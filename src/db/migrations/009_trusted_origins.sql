create table if not exists core.trusted_origins (
  id uuid primary key default gen_random_uuid(),
  origin text not null,
  is_enabled boolean not null default true,
  note text,
  created_at timestamptz not null default now(),
  created_by text
);

create unique index if not exists trusted_origins_origin_lower_uidx
  on core.trusted_origins (lower(origin));
