# hekatoncheiros-core

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
