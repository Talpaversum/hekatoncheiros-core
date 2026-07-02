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
