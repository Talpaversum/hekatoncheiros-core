# Core API Surface (Draft v0.1)

## Principles

- All endpoints are versioned: `/api/v1/...`.
- Every request has an enforced `RequestContext`:
  - `actor`: real user, effective user (impersonation), delegation metadata
  - `tenant`: tenant id + tenancy mode
- Apps never receive raw platform auth tokens (they get context injected via gateway or signed context tokens).

## Authentication & session

### POST /api/v1/auth/login

**Request**

```json
{ "email": "user@x", "password": "..." }
```

**Response**

```json
{ "access_token": "jwt-or-opaque", "expires_at": "2026-02-03T12:00:00Z" }
```

### POST /api/v1/auth/logout

**Response**: `204`

### POST /api/v1/auth/refresh

**Request**

```json
{ "refresh_token": "..." }
```

**Response**

```json
{ "access_token": "...", "expires_at": "..." }
```

## Context (what apps rely on)

### GET /api/v1/context

**Response**

```json
{
  "tenant": { "id": "tnt_123", "mode": "db_per_tenant" },
  "actor": {
    "user_id": "usr_123",
    "effective_user_id": "usr_123",
    "impersonating": false,
    "delegation": null
  },
  "privileges": ["inventory.read", "inventory.write"],
  "licenses": {
    "app_inventory": {
      "state": "active",
      "plan": "pro",
      "expires_at": null,
      "features": { "batch_import": true },
      "limits": { "items_max": 100000 }
    }
  }
}
```

## Tenants

### POST /api/v1/tenants (platform superadmin only OR install-time only)

**Request**

```json
{ "name": "Acme", "primary_domain": "acme.example.com" }
```

**Response**

```json
{ "id": "tnt_123", "name": "Acme", "status": "active" }
```

### GET /api/v1/tenants/me

**Response** includes tenant policy snapshot:

```json
{
  "id": "tnt_123",
  "name": "Acme",
  "policy": {
    "cross_tenant_collab": { "allowed_apps": ["app_inventory"], "default_scope": "read" }
  }
}
```

## Users (core-owned; apps may read, never modify)

### GET /api/v1/users/me

```json
{ "id": "usr_123", "email": "u@x", "display_name": "User", "status": "active" }
```

### GET /api/v1/users/{id} (privilege-gated, tenant-scoped)

```json
{ "id": "usr_456", "display_name": "Other", "status": "active" }
```

## Privileges / authorization (read-only surfaces)

### GET /api/v1/access/privileges/me

```json
{ "privileges": ["inventory.read", "inventory.write"] }
```

## Impersonation (admin-scoped)

### POST /api/v1/access/impersonation/start

```json
{ "target_user_id": "usr_456", "reason": "support", "scope": "tenant" }
```

**Response**

```json
{ "impersonation_id": "imp_123", "effective_user_id": "usr_456" }
```

### POST /api/v1/access/impersonation/stop

```json
{ "impersonation_id": "imp_123" }
```

**Response**: `204`

## Delegation (user-granted)

### POST /api/v1/access/delegations

```json
{
  "delegate_user_id": "usr_789",
  "actions": ["inventory.approve_order", "inventory.create_item"],
  "valid_from": "2026-02-03T00:00:00Z",
  "valid_to": "2026-02-10T00:00:00Z"
}
```

**Response**

```json
{ "delegation_id": "del_123", "status": "active" }
```

### GET /api/v1/access/delegations/me

```json
{ "granted": [], "received": [] }
```

## Licensing (core validates; apps enforce)

### GET /api/v1/licensing/apps/{app_id}

```json
{
  "app_id": "app_inventory",
  "state": "active",
  "plan": "pro",
  "expires_at": null,
  "features": { "batch_import": true },
  "limits": { "items_max": 100000, "users_max": 200 }
}
```

### POST /api/v1/licensing/apps/{app_id}/activate-offline (tenant admin)

```json
{ "license_blob": "BASE64", "signature": "BASE64" }
```

**Response**

```json
{ "state": "active", "plan": "pro", "expires_at": "2027-02-03T00:00:00Z" }
```

## Apps: registry and per-tenant enablement

### POST /api/v1/apps/register (platform admin)

```json
{ "manifest": { "...": "..." } }
```

**Response**

```json
{ "app_id": "app_inventory", "version": "1.2.0", "status": "registered" }
```

### POST /api/v1/tenants/apps/{app_id}/enable (tenant admin)

```json
{ "version": "1.2.0", "config": { "readonly_on_expiry": true } }
```

**Response**

```json
{ "enabled": true, "app_id": "app_inventory", "version": "1.2.0" }
```

### POST /api/v1/tenants/apps/{app_id}/disable

**Response**: `204`

## Events (core broker surfaces)

### POST /api/v1/events/publish (apps only; authenticated as app identity)

```json
{ "type": "inventory.item.created", "payload": { "item_id": "it_123" } }
```

**Response**

```json
{ "event_id": "evt_123" }
```

### POST /api/v1/events/consume (apps only)

```json
{ "consumer_app_id": "app_inventory", "max": 50 }
```

**Response**

```json
{
  "events": [
    { "event_id": "evt_123", "type": "core.license.changed", "payload": { "app_id": "app_inventory" } }
  ]
}
```

### POST /api/v1/events/ack (apps only)

```json
{ "consumer_app_id": "app_inventory", "event_ids": ["evt_123"] }
```

**Response**: `204`

## Audit

### POST /api/v1/audit/record (apps; append-only)

```json
{
  "action": "inventory.item.update",
  "object_ref": "inventory:item:it_123",
  "metadata": { "changed": ["name"] }
}
```

**Response**: `204`
