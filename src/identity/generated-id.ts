import { randomBytes } from "node:crypto";

import type { PoolClient } from "pg";

const MAX_ID_LENGTH = 80;

export function normalizeIdentifierSlug(value: string, fallback = "item"): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return (normalized || fallback).slice(0, 64).replace(/_+$/g, "") || fallback;
}

export function userSlugSource(input: {
  nickname?: string | null;
  displayName?: string | null;
  email: string;
}): string {
  return (
    input.nickname?.trim() ||
    input.displayName?.trim() ||
    input.email.split("@")[0]?.trim() ||
    randomBytes(6).toString("hex")
  );
}

export function nextAvailableIdentifier(
  prefix: "usr" | "tnt",
  slug: string,
  existingIds: Iterable<string>,
): string {
  const normalized = normalizeIdentifierSlug(slug, prefix === "usr" ? "user" : "tenant");
  const base = `${prefix}_${normalized}`.slice(0, MAX_ID_LENGTH);
  const existing = new Set(existingIds);
  if (!existing.has(base)) return base;
  for (let sequence = 2; sequence <= 999; sequence += 1) {
    const suffix = `_${String(sequence).padStart(3, "0")}`;
    const candidate = `${base.slice(0, MAX_ID_LENGTH - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`No available ${prefix} identifier for ${normalized}`);
}

export async function generateDatabaseIdentifier(
  client: PoolClient,
  table: "users" | "tenants",
  prefix: "usr" | "tnt",
  source: string,
): Promise<string> {
  const slug = normalizeIdentifierSlug(source, prefix === "usr" ? "user" : "tenant");
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `generated-id:${prefix}:${slug}`,
  ]);
  const result = await client.query(`select id from core.${table} where id = $1 or id like $2`, [
    `${prefix}_${slug}`.slice(0, MAX_ID_LENGTH),
    `${prefix}_${slug.slice(0, 60)}_%`,
  ]);
  return nextAvailableIdentifier(
    prefix,
    slug,
    result.rows.map((row) => String(row["id"])),
  );
}
