import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HandoffInbox } from "./index.js";

const run = promisify(execFile);

describe("HandoffInbox", () => {
  it("lists, verifies and imports a branch bundle below the workspace root", async () => {
    const root = await mkdtemp(join(tmpdir(), "handoff-inbox-"));
    const source = join(root, "source");
    const inbox = join(root, "inbox");
    const workspace = join(root, "workspace");
    await mkdir(source);
    await mkdir(inbox);
    await mkdir(workspace);
    await run("git", ["init", "-b", "main"], { cwd: source });
    await run("git", ["config", "user.name", "Handoff Test"], { cwd: source });
    await run("git", ["config", "user.email", "handoff@example.invalid"], { cwd: source });
    await writeFile(join(source, "README.md"), "from the Mac\n");
    await run("git", ["add", "README.md"], { cwd: source });
    await run("git", ["commit", "-m", "snapshot"], { cwd: source });
    const handoffId = "11111111-1111-4111-8111-111111111111";
    const temporary = join(root, "snapshot.bundle");
    await run("git", ["bundle", "create", temporary, "main"], { cwd: source });
    await rename(temporary, join(inbox, `${handoffId}--sample.bundle`));

    const service = new HandoffInbox(inbox, workspace);
    const listed = await service.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ handoffId, projectId: "sample", branch: "main" });

    const imported = await service.import(handoffId);
    expect(imported.path.startsWith(await realpath(workspace))).toBe(true);
    expect(await readFile(join(imported.path, "README.md"), "utf8")).toBe("from the Mac\n");
    expect((await service.list())).toHaveLength(0);
  });
});
