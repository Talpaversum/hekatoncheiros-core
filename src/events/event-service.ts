import { getPool } from "../db/pool.js";

export interface EventRecord {
  event_id: string;
  type: string;
  payload: Record<string, unknown>;
}

export async function publishEvent(params: {
  tenantId: string;
  sourceAppId: string;
  type: string;
  payload: Record<string, unknown>;
}): Promise<{ event_id: string }> {
  const pool = getPool();
  const result = await pool.query(
    "insert into core.events (tenant_id, source_app_id, type, payload) values ($1, $2, $3, $4) returning id",
    [params.tenantId, params.sourceAppId, params.type, params.payload],
  );
  return { event_id: result.rows[0].id };
}

export async function consumeEvents(params: {
  tenantId: string;
  consumerAppId: string;
  max: number;
}): Promise<{ events: EventRecord[] }> {
  const pool = getPool();
  const result = await pool.query(
    "select e.id, e.type, e.payload from core.events e where e.tenant_id = $1 and not exists (select 1 from core.event_consumption c where c.consumer_app_id = $2 and c.event_id = e.id) order by e.created_at asc limit $3",
    [params.tenantId, params.consumerAppId, params.max],
  );
  return {
    events: result.rows.map((row) => ({
      event_id: row.id,
      type: row.type,
      payload: row.payload ?? {},
    })),
  };
}

export async function acknowledgeEvents(params: {
  tenantId: string;
  consumerAppId: string;
  eventIds: string[];
}) {
  const pool = getPool();
  const values = params.eventIds.map((eventId) => [params.consumerAppId, eventId, params.tenantId]);
  for (const [consumerAppId, eventId, tenantId] of values) {
    await pool.query(
      "insert into core.event_consumption (consumer_app_id, event_id, tenant_id) values ($1, $2, $3) on conflict do nothing",
      [consumerAppId, eventId, tenantId],
    );
  }
}
