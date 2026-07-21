insert into core.tenant_member_roles (tenant_membership_id, role_id)
select membership.id, role.id
from core.user_privileges grant_record
join core.tenant_memberships membership
  on membership.user_id=grant_record.user_id and membership.tenant_id=grant_record.tenant_id
join core.tenant_roles role
  on role.tenant_id=membership.tenant_id and role.key='tenant_admin'
where grant_record.privilege='tenant.config.manage'
on conflict do nothing;

insert into core.tenant_member_roles (tenant_membership_id, role_id)
select membership.id, role.id
from core.user_privileges grant_record
join core.tenant_memberships membership
  on membership.user_id=grant_record.user_id and membership.tenant_id=grant_record.tenant_id
join core.tenant_roles role
  on role.tenant_id=membership.tenant_id and role.key='tenant_auditor'
where grant_record.privilege='core.audit.read.tenant'
on conflict do nothing;
