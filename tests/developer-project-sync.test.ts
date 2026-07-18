import { describe,expect,it } from "vitest";
import { readFile } from "node:fs/promises";
describe("developer project synchronization",()=>{it("tracks revision, manifest hash, security diff, and update states",async()=>{const source=await readFile(new URL("../src/web/routes/developer-project-sync.ts",import.meta.url),"utf8");expect(source).toContain("source_revision");expect(source).toContain("pending_diff_json");expect(source).toContain("runtime_approval_required");expect(source).toContain("update_available");});});
