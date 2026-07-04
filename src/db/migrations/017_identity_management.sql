create unique index if not exists users_email_lower_unique_idx
  on core.users (lower(email));

alter table core.user_privileges
  alter column tenant_id drop not null;
