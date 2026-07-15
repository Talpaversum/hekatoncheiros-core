create table if not exists core.user_preferences (
  user_id text not null references core.users(id) on delete cascade,
  namespace text not null,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, namespace),
  constraint user_preferences_namespace_check check (namespace ~ '^[a-z][a-z0-9._-]{0,79}$')
);

create index if not exists user_preferences_updated_idx on core.user_preferences (updated_at desc);
