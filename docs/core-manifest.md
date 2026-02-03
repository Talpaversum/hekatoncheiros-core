# Hekatoncheiros App Manifest Specification
> Draft v0.1

## Purpose

The App Manifest is the single, authoritative declaration of how an application integrates with the Hekatoncheiros Platform Kernel.

It exists to:

- enforce isolation
- enable safe multi-tenancy
- support licensing and marketplaces
- enable automated validation (by core and by agents such as Cline)
- prevent implicit or undocumented coupling

An app cannot be installed or enabled without a valid manifest.

## Manifest Scope and Guarantees

The manifest declares:

- identity and ownership
- data ownership
- permissions and privileges
- licensing model
- integration points (API, events, UI)
- collaboration constraints

The Platform Kernel guarantees that:

- the manifest is validated before app activation
- declared contracts are enforced
- undeclared behavior is rejected

## App Identity

Each app must declare:

- `app_id`
  - globally unique
  - immutable
  - reverse-domain or org-prefixed recommended
- `app_name`
  - human-readable
  - not required to be unique
- `version`
  - semantic version
  - used for compatibility checks
- `vendor`
  - legal or organizational identity
  - used for marketplace attribution

## Tenancy Awareness

Apps are tenant-agnostic by design.

The manifest must declare:

- whether the app is:
  - tenant-scoped (default)
  - supports cross-tenant collaboration (explicit opt-in)

### Cross-tenant collaboration rules

Cross-tenant collaboration is mediated exclusively by the core.

Apps never resolve foreign tenant identities directly.

Sharing scope is defined by:

- inviting tenant policy
- user privileges
- app-declared collaboration surface

Apps must explicitly declare:

- what objects (if any) are shareable
- what operations are allowed in shared context (read, comment, act)

## Data Ownership Declaration

Each app must declare:

- the schemas it owns
- that it does not access any other schema

Rules:

- one app → one or more schemas
- no cross-app foreign keys
- no shared tables
- no implicit joins

This declaration allows:

- schema provisioning
- permission enforcement
- migration isolation
- AGPL boundary clarity

## Permissions and Privileges

Apps must declare:

- required privileges
- optional privileges
- privilege scopes (tenant / department / group)

Privileges are:

- defined by the core
- evaluated by the core
- consumed by the app

Apps may never:

- define new privilege semantics
- bypass privilege evaluation
- escalate privileges

## Impersonation and Delegation

### Impersonation

Declared support must specify:

- whether impersonation is allowed
- which roles may impersonate
- scope of impersonation (tenant / department / group)

Rules:

- full impersonation is allowed only for admins of the relevant scope
- no cross-tenant impersonation
- platform superadmin is the only exception
- all impersonation is auditable and explicit

### Delegation

Apps may opt into delegation support.

Delegation means:

- User A authorizes User B to perform specific actions on their behalf

Scope is:

- action-limited
- time-limited
- revocable

Delegation is:

- granted by the user
- evaluated by the core
- enforced by the app

## Licensing Declaration

Each app must declare its license model, independently of the core.

The manifest must specify:

- license types supported:
  - perpetual
  - time-limited
  - scale-limited (users, workload, entities)
- feature flags tied to license state
- behavior on license expiry

### Offline licensing model (clarified)

- license activation is explicit and manual
- license is cryptographically validated by the core
- no online checks are required after activation
- no early revocation exists

### On license expiration

- features are disabled non-destructively
- app enters read-only mode

Existing data remains:

- accessible
- queryable
- available to other apps via APIs

No automatic deletion or mutation is allowed.

Core responsibility:

- validate license
- report license state and limits

App responsibility:

- enforce limits
- enforce feature availability

## API Integration

Apps must declare:

- APIs they expose
- APIs they consume from the core

Rules:

- all core interaction happens via API
- no direct DB access to core data
- APIs are versioned
- backward compatibility rules are enforced by the core

## Event Integration

Apps must declare:

- events they emit
- events they consume

### Delivery semantics (clarified)

- exactly-once delivery is a design goal
- implementation may internally use retries, deduplication, or persistence
- apps must be idempotent
- apps must tolerate retries

From the app’s perspective:

- an event is processed once
- duplicates must not cause side effects

## UI Integration

Apps may declare:

- navigation entries
- UI surfaces
- configuration panels

Rules:

- UI is hosted inside the platform shell
- no app may override core UI
- visibility is privilege-based

## Prohibited Behavior (Hard Enforcement)

Apps may never:

- manage users, tenants, or privileges
- modify another app’s data
- access undeclared schemas
- bypass licensing information
- bypass audit logging
- perform cross-tenant actions without explicit core mediation

Violations result in:

- app disablement
- marketplace rejection
- administrative intervention

## Validation and Enforcement

Manifests are validated at:

- install time
- upgrade time

Incompatible changes require explicit admin approval.

Core may refuse to load an app with:

- missing declarations
- privilege violations
- unsafe collaboration scopes

## Status

This manifest specification is intentionally strict.

It trades:

- flexibility → safety
- convenience → long-term maintainability
- implicit behavior → explicit contracts

This is aligned with:

- AGPL core
- marketplace goals
- multi-tenant self-hosting
- agent-assisted development
