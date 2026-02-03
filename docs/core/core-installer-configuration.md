# Core installer configuration

## Goals

- One-time web UI
- Supports:
  - Single-tenant
  - Multi-tenant DB-per-tenant
  - Row-level mode (optional)
- Produces a final config file and disables itself

## Installer steps

- Welcome + environment checks
  - Write permissions
  - DB connectivity
  - Required extensions/services
- Choose tenancy mode
  - Single-tenant
  - Multi-tenant (DB-per-tenant)
  - Row-level tenancy (advanced)
- Database configuration
  - Host/port/user/password
  - For DB-per-tenant:
    - “Admin DB user” for provisioning tenant DBs
    - Naming convention / prefix
- Platform identity
  - Instance name
  - Base URL
  - Email sender config (optional now)
- Create initial admin
  - Email/password
  - Initial tenant (name, domain) if multi-tenant
- Provision
  - Create schema(s)
  - Run core migrations
  - Create initial tenant DB if needed
  - Write config
- Lock installer
  - Create install.lock
  - Require explicit manual removal to re-run

## Configuration file (core values)

- TENANCY_MODE = single | db_per_tenant | row_level
- DB_ADMIN_DSN (only if db_per_tenant; optionally removable after provisioning if you support manual tenant DB creation)
- DB_DSN (single-tenant or row-level)
- SECURITY_KEYS (generated secrets)
- BASE_URL
- MAIL_PROVIDER settings
- EVENT_BACKEND settings

## Security rules

- Installer is inaccessible after lock
- Secrets never logged
- Config file permissions hardened
