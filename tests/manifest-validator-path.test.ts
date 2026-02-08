import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { SCHEMA_PATH } from "../src/apps/manifest-validator.js";

describe("manifest validator schema path", () => {
  it("uses absolute schema path independent of process.cwd", () => {
    const originalCwd = process.cwd();

    try {
      expect(path.isAbsolute(SCHEMA_PATH)).toBe(true);
      expect(existsSync(SCHEMA_PATH)).toBe(true);

      process.chdir(os.tmpdir());

      expect(path.isAbsolute(SCHEMA_PATH)).toBe(true);
      expect(existsSync(SCHEMA_PATH)).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
