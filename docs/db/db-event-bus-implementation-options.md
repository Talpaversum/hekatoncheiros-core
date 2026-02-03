# Core event bus implementation options

## Option A: Postgres-native event store + poller (recommended early)

- Events written to `core.events` in the same DB transaction as the action
- Delivery worker polls undelivered events and dispatches
- Consumers dedupe using `event_id`

**Pros**

- Simplest deployment (no extra infra)
- Reliable if built carefully
- Ideal for self-host

**Cons**

- Throughput limits vs dedicated brokers
- Worker/polling complexity

## Option B: External broker (RabbitMQ/NATS/Kafka)

- Core persists event and publishes to broker
- Consumers subscribe via broker

**Pros**

- Scale and performance
- Good tooling

**Cons**

- Extra operational burden for self-host
- Still need persistence/dedupe for correctness

## Option C: Hybrid (outbox pattern)

- Write to DB outbox table in transaction
- Separate relay publishes to broker
- Consumers dedupe

**Pros**

- Best correctness story at scale
- Decouples broker outages

**Cons**

- More moving parts

## Recommendation

Start with Option A (Postgres-native, outbox-like).

Keep the internal interfaces so you can swap to Option C later without changing apps.
