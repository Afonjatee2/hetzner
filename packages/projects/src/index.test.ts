import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProtectedPath, ProjectService, resolveContained } from "./index.js";
import { WorkspaceDatabase } from "@gpt-dev/persistence";

describe("resolveContained", () => {
  it("rejects traversal and symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "gptdev-root-"));
    const outside = await mkdtemp(join(tmpdir(), "gptdev-outside-"));
    await mkdir(join(root, "safe"));
    await writeFile(join(outside, "secret"), "no");
    await symlink(outside, join(root, "escape"));
    await expect(resolveContained(root, "../etc/passwd")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(resolveContained(root, "escape/secret")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("ProjectService security boundary", () => {
  it("rejects projects outside the configured workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "gptdev-approved-"));
    const outside = await mkdtemp(join(tmpdir(), "gptdev-unapproved-"));
    await mkdir(join(outside, ".git"));
    const database = new WorkspaceDatabase(join(root, "state", "app.db"));
    const service = new ProjectService(database, root);
    expect(() => service.register({ id: "outside", canonicalPath: outside, defaultBranch: "main", runtime: "generic" })).toThrow(/outside/);
    database.close();
  });

  it("blocks credential-bearing paths while allowing examples", () => {
    expect(isProtectedPath(".env")).toBe(true);
    expect(isProtectedPath("config/.env.local")).toBe(true);
    expect(isProtectedPath("deploy/private.pem")).toBe(true);
    expect(isProtectedPath(".aws/credentials")).toBe(true);
    expect(isProtectedPath(".env.example")).toBe(false);
    expect(isProtectedPath("src/config.ts")).toBe(false);
  });
});
