# hekatoncheiros-core

> ⚠️ **Project status: Early development**
>
> This project is part of the Hekatoncheiros platform and is under active development.
> APIs, features, and internal architecture are not yet stable and may change.
> This repository is not production-ready.

Platform kernel: auth, tenancy, app registry, licensing, events.

## Quick start (MVP)

1) Start Postgres:

```bash
docker compose up -d
```

2) Set env:

```bash
cp .env.example .env
```

3) Migrations + seed:

```bash
npm run db:migrate
npm run db:seed
```

4) Run the API:

```bash
npm run dev
```

API runs at `http://localhost:3000/api/v1` and the Swagger UI at `http://localhost:3000/docs`.

## Docker Compose deployment

The Compose deployment builds local images for Core and the web shell and runs:

- PostgreSQL
- Core API
- web shell served by nginx, with `/api/v1/*` proxied to Core

Start the stack:

```bash
docker compose up -d --build
```

Seed the default tenant and admin user once:

```bash
docker compose run --rm core-seed
```

Open:

- Web shell: `http://localhost:8080`
- Core API: `http://localhost:3000/api/v1`
- Swagger UI: `http://localhost:8080/docs`

Default seeded login:

- email: `admin@example.com`
- password: `admin`

Override ports and secrets with environment variables or a local `.env` file.
The built-in defaults are for development only.

To let Core build and start application runtime packages, use the explicit runtime
override:

```bash
docker compose -f docker-compose.yml -f docker-compose.runtime.yml up -d --build
```

The override enables the Docker Compose runtime, maps `host.docker.internal` on Linux,
and mounts the host Docker socket into Core. Access to that socket is equivalent to host
administrator access, so only use this mode for a trusted Core installation and trusted
application packages.

For optional HTTPS termination, place `tls.crt` and `tls.key` in an untracked
certificate directory and start the ingress override:

```bash
HTTPS_SERVER_NAME=hc.example.com HTTPS_CERT_DIR=/secure/hc-certs \
  docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
```

HTTPS is exposed on `${HTTPS_PUBLISHED_PORT:-8443}` and the HTTP redirect on
`${HTTP_REDIRECT_PUBLISHED_PORT:-8081}`. In production, bind the direct Core,
web, and PostgreSQL published ports to loopback or block them at the host
firewall so clients cannot bypass the HTTPS ingress.

Core-managed applications receive their short-lived Core API token as a Compose secret,
not as an environment value. The runtime gets `HC_CORE_APP_TOKEN_FILE`, currently pointing
to `/run/secrets/hc_core_app_token`, and must read the token from that file whenever it makes
a Core API request. Administrators can rotate the mounted token without copying its value:
`POST /api/v1/apps/installed/:app_id/runtime/token/rotate`.

## Scripts

- `npm run dev` – dev server
- `npm run build` – TS build
- `npm run start` – start from `dist`
- `npm run db:migrate` – apply migrations
- `npm run db:seed` – seed base data
- `npm run codegen:openapi` – generate types from OpenAPI

## Notes

- The tenancy resolver is currently `HeaderTenantResolver` (header `x-tenant-id`).
- DB-per-tenant is prepared as an interface, but the MVP uses a shared DB.
- JWT tokens are verified using the shared `JWT_SECRET`.
