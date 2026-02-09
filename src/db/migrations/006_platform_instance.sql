create table if not exists core.platform_instance (
  id int primary key default 1,
  instance_id uuid not null,
  created_at timestamptz not null default now()
);
