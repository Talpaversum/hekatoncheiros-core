import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonicalizeWorkspacePath, validateRepositoryReference } from "../src/developer/source-providers.js";

const root = await mkdtemp(join(tmpdir(), "hc-workspace-"));
const appPath = join(root, "apps", "sample");
await mkdir(appPath, { recursive: true });
afterAll(() => rm(root, { recursive: true, force: true }));

describe("developer source providers", () => {
  it("canonicalizes only paths below configured server roots", async () => {
    const config = { DEVELOPER_WORKSPACE_ROOTS: join(root, "apps") } as never;
    await expect(canonicalizeWorkspacePath(appPath, config)).resolves.toBe(appPath);
    await expect(canonicalizeWorkspacePath(root, config)).rejects.toMatchObject({ statusCode: 403 });
  });
  it("accepts explicit repository reference formats", () => {
    expect(validateRepositoryReference("github", "openai/codex")).toBe("openai/codex");
    expect(validateRepositoryReference("git", "git@example.test:team/app.git")).toContain("app.git");
    expect(() => validateRepositoryReference("git", "http://example.test/app.git")).toThrow();
  });
});
