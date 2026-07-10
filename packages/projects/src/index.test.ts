import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveContained } from "./index.js";

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

