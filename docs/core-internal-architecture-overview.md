Hekatoncheiros Core – Internal Architecture Overview

Draft v0.1

1. Purpose of the Core

The Core is a platform kernel, not a business system.

Its responsibilities are:

identity and access control

tenancy resolution

app coordination and isolation

licensing distribution

auditability

cross-tenant collaboration mediation

The Core does not:

implement domain logic

enforce app limits

own app data

interpret app semantics

2. High-level architecture (conceptual)

The Core is composed of strictly layered subsystems:

Ingress layer (HTTP/API)

Context resolution layer

Authorization & policy layer

Service layer

Integration layer (events, apps, UI)

Persistence layer

Installer & lifecycle management

Each layer has no knowledge of layers below it beyond contracts.

3. Request lifecycle (authoritative flow)

Every request entering the system follows this sequence:

Ingress

Request arrives via HTTP

Auth token or session extracted

Identity resolution

User identity resolved

Authentication validated

Tenant resolution

Tenant determined via:

domain

header

token claims

TenantContext created

Authorization

Privileges evaluated

Delegation checked

Impersonation applied (if present)

License context

Active licenses for tenant resolved

License metadata attached to request

Routing

Request routed to:

Core service

App API

UI surface

Audit

Action recorded (before and/or after execution)

This pipeline is non-bypassable.

4. Tenant resolution & DB routing
TenantContext

The Core creates a TenantContext object containing:

tenant_id

tenancy_mode

DB routing info

enabled apps

license state

This object is immutable for the request lifetime.

Tenancy modes (implementation)
A) Single-tenant self-host

One DB

Schemas per app

No tenant_id columns required

B) Multi-tenant (DB-per-tenant)

One DB per tenant

Schemas:

core

app_*

DB connection selected via TenantContext

C) Row-level tenancy (optional)

Shared DB

tenant_id enforced via:

query scoping

PostgreSQL RLS

Hidden from apps

Apps never know which mode is active.

5. Persistence model
Core database schema

Core owns:

users

tenants

departments

groups

privileges

delegations

impersonation records

licenses

audit logs

app registry

Core schema is never accessed by apps directly.

App schemas

One schema per app

Provisioned at install time

Migrated independently

Permissions enforced at DB role level where possible

6. App registry & lifecycle
App registry

The Core maintains:

installed apps

app versions

manifest data

enabled/disabled state per tenant

App lifecycle

Upload / register app

Validate manifest

Provision schema

Register API routes

Register events

Enable app per tenant

Disablement:

revokes routing

preserves data

preserves API read-only access if app declares it

7. API architecture
Core API

Versioned

Stable contracts

Authenticated and authorized

Exposes:

identity

privileges

tenant context

license data

audit submission

messaging primitives

App APIs

Routed through the Core

Context injected automatically

Apps cannot access raw auth tokens

8. Licensing flow (runtime)

License entered (online or offline)

Core validates signature

License stored in core schema

License metadata derived:

features

limits

expiry

License context attached to requests

Apps query license state via Core API

On expiration:

Core reports expired state

Apps enforce read-only mode

No data deletion occurs

9. Event system
Design goal

Exactly-once semantics at logical level

Practical implementation

Events persisted before delivery

Each event has:

unique ID

source app

tenant scope

Consumers track processed IDs

Retries allowed

Side effects must be idempotent

Apps must assume retries are possible.

10. Cross-tenant collaboration
Core mediation

Core resolves:

foreign tenant identities

shared object references

Apps receive:

abstract collaboration tokens

permission-scoped views

Apps never:

resolve foreign users

query foreign tenant DBs

11. Impersonation & delegation (runtime)
Impersonation

Applied at context layer

Visible in audit logs

Explicit in API context

Delegation

Evaluated per action

Action-scoped

Time-limited

Revocable

Apps receive:

effective user

delegation metadata

12. Security boundaries

Hard boundaries:

No shared DB access

No shared code imports

No implicit privileges

No hidden APIs

Soft boundaries (enforced by tooling):

lint rules

CI checks

manifest validation

agent rules (Cline)

13. Installer & lifecycle
Installer responsibilities

Initial config

Tenancy mode selection

DB provisioning

Admin creation

One-time execution

Installer must:

disable itself after completion

never run during normal operation

14. Observability & audit

Core guarantees:

every privileged action is auditable

impersonation and delegation are visible

license changes are logged

app actions can emit audit events

15. Non-goals (explicit)

The Core will not:

optimize app queries

understand app schemas

auto-scale app resources

interpret app business logic

Status

This architecture is:

intentionally conservative

hostile to shortcuts

friendly to long-term maintenance

compatible with AGPL and marketplaces

suitable for agent-assisted development
