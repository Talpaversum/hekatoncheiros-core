alter table core.platform_instance
  add column if not exists runtime_health_interval_ms integer not null default 5000,
  add column if not exists runtime_health_timeout_ms integer not null default 1500,
  add column if not exists runtime_health_failure_threshold integer not null default 2;

alter table core.platform_instance
  drop constraint if exists platform_instance_runtime_health_check,
  add constraint platform_instance_runtime_health_check check (
    runtime_health_interval_ms between 1000 and 300000 and
    runtime_health_timeout_ms between 100 and 30000 and
    runtime_health_failure_threshold between 1 and 10
  );
