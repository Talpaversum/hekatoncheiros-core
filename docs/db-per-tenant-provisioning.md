# DB-per-tenant provisioning algorithm (Draft v0.1)

## Inputs

- `tenant_id`, `tenant_name`
- `tenancy_mode = db_per_tenant`
- `db_admin_dsn` (provisioning credential)
- `db_template` (optional template DB name)
- `db_name_prefix` (e.g., `hc_tenant_`)
- `schema_list = ["core"] + ["app_x", ... enabled apps ...]`

## Outputs

- A new tenant database
- Core schema migrated
- App schemas provisioned for enabled apps
- Tenant marked active

## Algorithm: create tenant

### Validate tenant request

- Check domain uniqueness
- Check tenant policy defaults

### Allocate DB name

- `db_name = prefix + tenant_id` (stable and collision-free)

### Create database

```sql
CREATE DATABASE db_name [TEMPLATE template_db];
```

### Create schemas

```sql
CREATE SCHEMA core;
```

- For each enabled app: `CREATE SCHEMA app_<id>;`

### Create DB roles

- `role_core_runtime`
- `role_app_<id>_runtime` for each app

### Grant schema permissions

- `role_core_runtime` gets full access to core schema
- each `role_app_*` gets full access only to its schema
- explicitly revoke access to other schemas

### Run core migrations

- Apply core migrations in core schema

### Seed tenant records

- Create tenant row (in that tenant DB if you keep per-tenant core DB)
- Create initial department defaults
- Create initial admin assignment

### Provision app migrations (if app enabled at creation time)

- For each enabled app:
  - Run app migrations in its schema

### Register routing

- Store tenant_id -> db_name mapping in platform control plane

### Audit

- Append audit event: `core.tenant.created`

## Upgrade/migration workflow (per tenant)

- For each tenant DB:
  - Migrate core first
  - Then migrate apps in a deterministic order (or independently)
- Record per-tenant migration state.

## Backup strategy (deployment-agnostic)

- Per tenant DB backup:
  - Daily full backup
  - Point-in-time recovery if enabled
- Support “export tenant” operation:
  - Dumps DB plus config snapshot

### Restore

- Restore DB
- Restore tenant mapping
- Validate schema versions

## Rotation / key changes

- Secret rotation affects:
  - Runtime DB credentials
  - App secrets
- DB admin credentials should not be used at runtime.
- Runtime uses least-privilege role credentials.

## One important consistency point

In DB-per-tenant mode, your earlier “per app DB and done” can be interpreted two ways:

- **Recommended**: per tenant DB, per app schema (default)
- **Optional strict**: per tenant and per app DB (only if demanded)

The contract already supports both, but the default should be schema-per-app to avoid operational explosion.
