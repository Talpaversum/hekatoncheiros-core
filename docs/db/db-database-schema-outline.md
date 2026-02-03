# Core database schema outline

This is the “v0” schema set that supports your contract. Names are illustrative.

## Identity

- `users`: id, tenant_id? (depends on mode), email, display_name, status, timestamps
- `user_identities`: external identities (OIDC subject, SSO provider)
- `user_credentials`: password hashes / MFA enrollment (or separate tables)
- `api_tokens`: token hashes, scopes, expiry

## Tenancy & org structure

- `tenants`: id, name, status, created_at
- `tenant_domains`: tenant ↔ domains/subdomains mapping
- `departments`: tenant-scoped organizational grouping
- `groups`: can be cross-tenant “workgroups”
- `group_memberships`: user ↔ group, role within group
- `tenant_policies`: sharing/collaboration constraints, defaults

## Access control

- `privileges`: canonical privilege names
- `roles`
- `role_privileges`
- `assignments`: user/department/group ↔ role assignment
- `policy_overrides`: optional per-tenant overrides

## Delegation & impersonation

- `delegations`: grantor_user_id, delegate_user_id, action_scope, time window, status
- `impersonation_sessions`: admin_user_id, target_user_id, scope, started_at, ended_at, reason

## Licensing

- `licenses`: tenant_id, app_id, license_blob, signature, issued_at, expires_at, status
- `license_entitlements`: derived features/limits snapshot for fast lookup (optional cache)
- `license_activations`: audit of activation inputs (never store secrets, only references)

## App registry

- `apps`: app_id, vendor, latest_version, manifest_hash
- `app_versions`: app_id, version, manifest_json, compatibility metadata
- `tenant_apps`: tenant_id, app_id, enabled, version_pinned, config
- `app_routes`: app_id, route prefix, versioning info (for gateway)

## Events

- `events`: id (UUID), tenant_id, source_app_id, type, payload, created_at
- `event_deliveries`: event_id, consumer_app_id, attempt_count, last_attempt_at, status
- `event_consumption`: consumer_app_id, event_id (or checkpoint), processed_at (dedupe)

## Audit

- `audit_log`: tenant_id, actor_user_id, effective_user_id, action, object_ref, metadata JSON, created_at
- Include delegation/impersonation flags

## Secrets

- `secrets`: tenant_id, app_id, secret_id, encrypted_blob, created_at, rotated_at, status
- `secret_access_log`: who/what accessed and when

## Notes

- In DB-per-tenant mode: these tables exist in each tenant DB under schema `core`.
- In row-level mode: add tenant_id to all tenant-scoped tables and enforce RLS.
