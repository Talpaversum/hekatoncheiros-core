with mapping(old_privilege,new_privilege) as (values
  ('platform.authors.manage','platform.authors.review'),
  ('platform.author_registry.manage','platform.author_registry.read'),
  ('author_registry.admin','platform.author_registry.keys.manage'),
  ('author_registry.approve','platform.author_registry.certificates.issue'),
  ('author_registry.revoke','platform.author_registry.revoke'),
  ('author_registry.audit.read','platform.author_registry.audit.read')
)
delete from core.user_privileges old using mapping m
where old.privilege=m.old_privilege and exists (
  select 1 from core.user_privileges current
  where current.user_id=old.user_id
    and current.tenant_id is not distinct from old.tenant_id
    and current.privilege=m.new_privilege
);

with mapping(old_privilege,new_privilege) as (values
  ('platform.authors.manage','platform.authors.review'),
  ('platform.author_registry.manage','platform.author_registry.read'),
  ('author_registry.admin','platform.author_registry.keys.manage'),
  ('author_registry.approve','platform.author_registry.certificates.issue'),
  ('author_registry.revoke','platform.author_registry.revoke'),
  ('author_registry.audit.read','platform.author_registry.audit.read')
)
update core.user_privileges grants set privilege=m.new_privilege
from mapping m where grants.privilege=m.old_privilege;

alter table core.author_profiles
  add column if not exists external_issuer_status text not null default 'not_applicable';

update core.author_profiles
set external_issuer_status='pending_review'
where operating_mode='trusted_self_hosted'
  and external_issuer_url is not null
  and external_issuer_status='not_applicable';

alter table core.author_profiles
  drop constraint if exists author_profiles_external_issuer_status_check;

alter table core.author_profiles
  add constraint author_profiles_external_issuer_status_check
  check (external_issuer_status in ('not_applicable','pending_review','approved','rejected'));
