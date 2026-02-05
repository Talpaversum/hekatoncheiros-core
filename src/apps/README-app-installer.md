# Temporary Dev Installer UI

This document describes the temporary, developer-only installer UI used during early development.

## Purpose

- provide a thin UI for installing/uninstalling apps without a wizard
- directly call core API endpoints
- store installations in the in-memory AppInstallationStore

## Limitations

- data is not persisted (in-memory only)
- not suitable for production
- will be replaced by marketplace / installer wizard

## API surface (core)

- `GET /api/v1/apps/installed`
- `POST /api/v1/apps/installed`
- `DELETE /api/v1/apps/installed/:app_id`

All requests require `platform.apps.manage` privilege.
