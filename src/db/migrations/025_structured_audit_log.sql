alter table core.audit_log alter column tenant_id drop not null;

alter table core.audit_log
  add column if not exists occurred_at timestamptz,
  add column if not exists received_at timestamptz not null default now(),
  add column if not exists scope text,
  add column if not exists visibility text,
  add column if not exists category text,
  add column if not exists severity text,
  add column if not exists outcome text,
  add column if not exists actor_type text,
  add column if not exists application_id text,
  add column if not exists source_service text,
  add column if not exists event_type text,
  add column if not exists resource_type text,
  add column if not exists resource_id text,
  add column if not exists correlation_id text,
  add column if not exists request_id text,
  add column if not exists ip_address inet,
  add column if not exists user_agent text,
  add column if not exists message text,
  add column if not exists schema_version integer;

update core.audit_log set
  occurred_at = coalesce(occurred_at, created_at),
  scope = coalesce(scope, 'tenant'),
  visibility = coalesce(visibility, 'tenant_admin'),
  category = coalesce(category, 'audit'),
  severity = coalesce(severity, 'info'),
  outcome = coalesce(outcome, 'unknown'),
  actor_type = coalesce(actor_type, case when actor_user_id is null then 'system' else 'user' end),
  source_service = coalesce(source_service, 'core'),
  event_type = coalesce(event_type, action),
  message = coalesce(message, action),
  schema_version = coalesce(schema_version, 1);

alter table core.audit_log
  alter column occurred_at set not null,
  alter column scope set not null,
  alter column visibility set not null,
  alter column category set not null,
  alter column severity set not null,
  alter column outcome set not null,
  alter column actor_type set not null,
  alter column source_service set not null,
  alter column event_type set not null,
  alter column message set not null,
  alter column schema_version set not null;

alter table core.audit_log
  add constraint audit_log_scope_check check (scope in ('user', 'tenant', 'platform')),
  add constraint audit_log_visibility_check check (visibility in ('user', 'tenant_admin', 'platform_admin')),
  add constraint audit_log_severity_check check (severity in ('debug', 'info', 'warning', 'error', 'critical')),
  add constraint audit_log_outcome_check check (outcome in ('success', 'failure', 'denied', 'unknown')),
  add constraint audit_log_actor_type_check check (actor_type in ('user', 'application', 'service', 'system', 'anonymous')),
  add constraint audit_log_tenant_scope_check check ((scope = 'platform' and tenant_id is null) or (scope <> 'platform' and tenant_id is not null));

create index if not exists audit_log_occurred_id_idx on core.audit_log (occurred_at desc, id desc);
create index if not exists audit_log_tenant_occurred_id_idx on core.audit_log (tenant_id, occurred_at desc, id desc);
create index if not exists audit_log_actor_occurred_id_idx on core.audit_log (actor_user_id, occurred_at desc, id desc);
create index if not exists audit_log_effective_occurred_id_idx on core.audit_log (effective_user_id, occurred_at desc, id desc);
create index if not exists audit_log_application_occurred_id_idx on core.audit_log (application_id, occurred_at desc, id desc);
create index if not exists audit_log_event_type_occurred_id_idx on core.audit_log (event_type, occurred_at desc, id desc);
create index if not exists audit_log_correlation_idx on core.audit_log (correlation_id);
