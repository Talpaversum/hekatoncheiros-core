# hekatoncheiros-core

Platform kernel: auth, tenancy, app registry, licensing, events.

## Rychlý start (MVP)

1) Spusť Postgres:

```bash
docker compose up -d
```

2) Nastav env:

```bash
cp .env.example .env
```

3) Migrace + seed:

```bash
npm run db:migrate
npm run db:seed
```

4) Spusť API:

```bash
npm run dev
```

API běží na `http://localhost:3000/api/v1` a swagger UI na `http://localhost:3000/docs`.

## Skripty

- `npm run dev` – dev server
- `npm run build` – TS build
- `npm run start` – start z `dist`
- `npm run db:migrate` – aplikace migrací
- `npm run db:seed` – seed základních dat
- `npm run codegen:openapi` – generování typů z OpenAPI

## Poznámky

- Tenancy resolver je zatím `HeaderTenantResolver` (header `x-tenant-id`).
- DB-per-tenant je připravené jako rozhraní, ale v MVP používáme shared DB.
- JWT tokeny jsou ověřované pomocí sdíleného `JWT_SECRET`.
