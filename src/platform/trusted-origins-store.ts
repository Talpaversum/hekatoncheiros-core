import { getPool } from "../db/pool.js";

export type TrustedOrigin = {
  id: string;
  origin: string;
  is_enabled: boolean;
  note: string | null;
  created_at: string;
  created_by: string | null;
};

export type CreateTrustedOriginInput = {
  origin: string;
  note?: string | null;
  createdBy?: string | null;
};

export type UpdateTrustedOriginInput = {
  is_enabled?: boolean;
  note?: string | null;
};

export function normalizeTrustedOrigin(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("origin is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("origin must be a valid URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("origin must use http or https");
  }

  if (parsed.username || parsed.password) {
    throw new Error("origin must not include username/password");
  }

  return parsed.origin;
}

function mapRow(row: Record<string, unknown>): TrustedOrigin {
  return {
    id: String(row["id"]),
    origin: String(row["origin"]),
    is_enabled: Boolean(row["is_enabled"]),
    note: (row["note"] as string | null) ?? null,
    created_at: new Date(String(row["created_at"])).toISOString(),
    created_by: (row["created_by"] as string | null) ?? null,
  };
}

export class TrustedOriginsStore {
  async list(): Promise<TrustedOrigin[]> {
    const pool = getPool();
    const result = await pool.query(
      `select id, origin, is_enabled, note, created_at, created_by
       from core.trusted_origins
       order by created_at desc`,
    );

    return result.rows.map((row) => mapRow(row));
  }

  async listEnabledOrigins(): Promise<Set<string>> {
    const pool = getPool();
    const result = await pool.query(
      `select origin
       from core.trusted_origins
       where is_enabled = true`,
    );

    return new Set(result.rows.map((row) => String(row.origin)));
  }

  async create(input: CreateTrustedOriginInput): Promise<TrustedOrigin> {
    const pool = getPool();
    const normalizedOrigin = normalizeTrustedOrigin(input.origin);
    const result = await pool.query(
      `insert into core.trusted_origins (origin, is_enabled, note, created_by)
       values ($1, true, $2, $3)
       returning id, origin, is_enabled, note, created_at, created_by`,
      [normalizedOrigin, input.note ?? null, input.createdBy ?? null],
    );

    return mapRow(result.rows[0]);
  }

  async update(id: string, patch: UpdateTrustedOriginInput): Promise<TrustedOrigin | null> {
    const pool = getPool();
    const updates: string[] = [];
    const values: unknown[] = [];

    if (patch.is_enabled !== undefined) {
      values.push(patch.is_enabled);
      updates.push(`is_enabled = $${values.length}`);
    }

    if (Object.prototype.hasOwnProperty.call(patch, "note")) {
      values.push(patch.note ?? null);
      updates.push(`note = $${values.length}`);
    }

    if (updates.length === 0) {
      const existing = await pool.query(
        `select id, origin, is_enabled, note, created_at, created_by
         from core.trusted_origins
         where id = $1`,
        [id],
      );
      return existing.rowCount ? mapRow(existing.rows[0]) : null;
    }

    values.push(id);
    const result = await pool.query(
      `update core.trusted_origins
       set ${updates.join(", ")}
       where id = $${values.length}
       returning id, origin, is_enabled, note, created_at, created_by`,
      values,
    );

    return result.rowCount ? mapRow(result.rows[0]) : null;
  }

  async delete(id: string): Promise<boolean> {
    const pool = getPool();
    const result = await pool.query("delete from core.trusted_origins where id = $1", [id]);
    return (result.rowCount ?? 0) > 0;
  }
}

const store = new TrustedOriginsStore();

export function getTrustedOriginsStore() {
  return store;
}
