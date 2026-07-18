import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("remove private author mode migration", () => {
  it("fails for approved legacy profiles before invalidating requests and tightening constraints", async () => {
    const sql = await readFile(new URL("../src/db/migrations/028_remove_private_author_mode.sql", import.meta.url), "utf8");
    const profileGuard = sql.indexOf("Cannot remove private_self_hosted");
    const requestInvalidation = sql.indexOf("set status = 'invalid_mode'");
    const requestConstraint = sql.lastIndexOf("author_requests_operating_mode_check");
    const profileConstraint = sql.lastIndexOf("author_profiles_operating_mode_check");

    expect(profileGuard).toBeGreaterThan(-1);
    expect(requestInvalidation).toBeGreaterThan(profileGuard);
    expect(requestConstraint).toBeGreaterThan(requestInvalidation);
    expect(profileConstraint).toBeGreaterThan(requestConstraint);
    expect(sql.match(/operating_mode in \('talpaversum_hosted','trusted_self_hosted'\)/g)).toHaveLength(2);
  });
});
