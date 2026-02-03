# Hekatoncheiros Core – Internal Architecture Overview
> Draft v0.1

## Purpose of the Core

The Core is a platform kernel, not a business system.

Its responsibilities are:

- identity and access control
- tenancy resolution
- app coordination and isolation
- licensing distribution
- auditability
- cross-tenant collaboration mediation

The Core does not:

- implement domain logic
- enforce app limits
- own app data
- interpret app semantics

## High-level architecture (conceptual)

The Core is composed of strictly layered subsystems:

- Ingress layer (HTTP/API)
- Context resolution layer
- Authorization & policy layer
- Service layer
- Integration layer (events, apps, UI)
- Persistence layer
- Installer & lifecycle management

Each layer has no knowledge of layers below it beyond contracts.

## Request lifecycle (authoritative flow)

Every request entering the system follows this sequence:

- Ingress
  - request arrives via HTTP
  - auth token or session extracted
- Identity resolution
  - user identity resolved
  - authentication validated
- Tenant resolution
  - tenant determined via:
    - domain
    - header
    - token claims
  - `TenantContext` created
- Authorization
  - privileges evaluated
  - delegation checked
  - impersonation applied (if present)
- License context
  - active licenses for tenant resolved
  - license metadata attached to request
- Routing
  - request routed to:
    - core service
    - app API
    - UI surface
- Audit
  - action recorded (before and/or after execution)

This pipeline is non-bypassable.

## Tenant resolution & DB routing

### TenantContext

The Core creates a `TenantContext` object containing:

- `tenant_id`
- `tenancy_mode`
- DB routing info
- enabled apps
- license state

This object is immutable for the request lifetime.

### Tenancy modes (implementation)

#### A) Single-tenant self-host

- one DB
- schemas per app
- no `tenant_id` columns required

#### B) Multi-tenant (DB-per-tenant)

- one DB per tenant
- schemas:
  - core
  - `app_*`
- DB connection selected via `TenantContext`

#### C) Row-level tenancy (optional)

- shared DB
- `tenant_id` enforced via:
  - query scoping
  - PostgreSQL RLS
- hidden from apps

Apps never know which mode is active.

## Persistence model

### Core database schema

Core owns:

- users
- tenants
- departments
- groups
- privileges
- delegations
- impersonation records
- licenses
- audit logs
- app registry

Core schema is never accessed by apps directly.

### App schemas

- one schema per app
- provisioned at install time
- migrated independently
- permissions enforced at DB role level where possible

## App registry & lifecycle

### App registry

The Core maintains:

- installed apps
- app versions
- manifest data
- enabled/disabled state per tenant

### App lifecycle

- upload / register app
- validate manifest
- provision schema
- register API routes
- register events
- enable app per tenant

Disablement:

- revokes routing
- preserves data
- preserves API read-only access if app declares it

## API architecture

### Core API

- versioned
- stable contracts
- authenticated and authorized

Exposes:

- identity
- privileges
- tenant context
- license data
- audit submission
- messaging primitives

### App APIs

- routed through the Core
- context injected automatically
- apps cannot access raw auth tokens

## Licensing flow (runtime)

- license entered (online or offline)
- core validates signature
- license stored in core schema
- license metadata derived:
  - features
  - limits
  - expiry
- license context attached to requests
- apps query license state via Core API

On expiration:

- core reports expired state
- apps enforce read-only mode
- no data deletion occurs

## Event system

### Design goal

- exactly-once semantics at logical level

### Practical implementation

- events persisted before delivery
- each event has:
  - unique ID
  - source app
  - tenant scope
- consumers track processed IDs
- retries allowed
- side effects must be idempotent

Apps must assume retries are possible.

## Cross-tenant collaboration

### Core mediation

Core resolves:

- foreign tenant identities
- shared object references

Apps receive:

- abstract collaboration tokens
- permission-scoped views

Apps never:

- resolve foreign users
- query foreign tenant DBs

## Impersonation & delegation (runtime)

### Impersonation

- applied at context layer
- visible in audit logs
- explicit in API context

### Delegation

- evaluated per action
- action-scoped
- time-limited
- revocable

Apps receive:

- effective user
- delegation metadata

## Security boundaries

### Hard boundaries

- no shared DB access
- no shared code imports
- no implicit privileges
- no hidden APIs

### Soft boundaries (enforced by tooling)

- lint rules
- CI checks
- manifest validation
- agent rules (Cline)

## Installer & lifecycle

### Installer responsibilities

- initial config
- tenancy mode selection
- DB provisioning
- admin creation
- one-time execution

Installer must:

- disable itself after completion
- never run during normal operation

## Observability & audit

Core guarantees:

- every privileged action is auditable
- impersonation and delegation are visible
- license changes are logged
- app actions can emit audit events

## Non-goals (explicit)

The Core will not:

- optimize app queries
- understand app schemas
- auto-scale app resources
- interpret app business logic

## Status

This architecture is:

- intentionally conservative
- hostile to shortcuts
- friendly to long-term maintenance
- compatible with AGPL and marketplaces
- suitable for agent-assisted development
