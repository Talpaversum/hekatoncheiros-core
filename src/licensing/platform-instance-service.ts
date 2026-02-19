import { randomUUID } from "node:crypto";

import { getPool } from "../db/pool.js";

let cachedInstanceId: string | null = null;

export async function ensurePlatformInstanceId(): Promise<string> {
  if (cachedInstanceId) {
    return cachedInstanceId;
  }

  const pool = getPool();

  const existing = await pool.query("select instance_id from core.platform_instance where id = 1");
  if ((existing.rowCount ?? 0) > 0) {
    cachedInstanceId = existing.rows[0].instance_id as string;
    return cachedInstanceId;
  }

  const instanceId = randomUUID();
  const inserted = await pool.query(
    "insert into core.platform_instance (id, instance_id) values (1, $1) on conflict (id) do update set instance_id = core.platform_instance.instance_id returning instance_id",
    [instanceId],
  );

  cachedInstanceId = inserted.rows[0].instance_id as string;
  return cachedInstanceId;
}

export async function getPlatformInstanceId(): Promise<string> {
  return ensurePlatformInstanceId();
}

export async function getPlatformInstanceAudienceId(): Promise<string> {
  const instanceId = await getPlatformInstanceId();
  return instanceId.startsWith("hcpi_") ? instanceId : `hcpi_${instanceId}`;
}
