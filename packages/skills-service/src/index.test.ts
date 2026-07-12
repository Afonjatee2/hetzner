import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkspaceError } from "@gpt-dev/schemas";
import { SkillsService } from "./index.js";

let root: string;
let outside: string;
let service: SkillsService;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "skills-root-"));
  outside = await mkdtemp(join(tmpdir(), "skills-outside-"));
  await writeFile(join(outside, "secret.md"), "outside the root");

  // Skill at the root itself, with nested support files and a nested child skill.
  await writeFile(join(root, "SKILL.md"), [
    "---",
    "name: report-design-system",
    "description: Route any Genesis deliverable to the right client design spec",
    "---",
    "# Genesis Report Design System"
  ].join("\n"));
  await mkdir(join(root, "aib-ni"), { recursive: true });
  await writeFile(join(root, "aib-ni", "layout-spec.md"), "# AIB NI layout spec");
  await writeFile(join(root, "aib-ni", "theme.json"), JSON.stringify({ brand: "51005B" }));
  await writeFile(join(root, "aib-ni", "reference.pptx"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  await mkdir(join(root, "shared", "humanised-commentary"), { recursive: true });
  await writeFile(join(root, "shared", "humanised-commentary", "SKILL.md"), [
    "---",
    "name: humanised-client-report-commentary",
    "description: Plain, calm, human commentary for client reports",
    "---",
    "body"
  ].join("\n"));
  // Folder without frontmatter name: falls back to folder name.
  await mkdir(join(root, "bare-skill"), { recursive: true });
  await writeFile(join(root, "bare-skill", "SKILL.md"), "no frontmatter here");
  // Protected file and an escape symlink inside a skill folder.
  await writeFile(join(root, "aib-ni", ".env"), "SECRET=1");
  await symlink(join(outside, "secret.md"), join(root, "aib-ni", "escape.md"));
  // Symlinks with allowed extensions pointing at protected/binary files INSIDE the root.
  await symlink(join(root, "aib-ni", ".env"), join(root, "aib-ni", "notes.md"));
  await symlink(join(root, "aib-ni", "reference.pptx"), join(root, "aib-ni", "deck.md"));
  // Text-extension file that actually contains binary data.
  await writeFile(join(root, "aib-ni", "garbled.md"), Buffer.from([0x68, 0x69, 0x00, 0x21]));

  service = new SkillsService(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("list", () => {
  it("discovers root and nested skills with frontmatter metadata", async () => {
    const skills = await service.list();
    const names = skills.map((skill) => skill.name);
    expect(names).toContain("report-design-system");
    expect(names).toContain("humanised-client-report-commentary");
    expect(names).toContain("bare-skill");
    const nested = skills.find((skill) => skill.name === "humanised-client-report-commentary");
    expect(nested?.dir).toBe("shared/humanised-commentary");
    expect(nested?.description).toMatch(/calm/);
  });

  it("filters with a query", async () => {
    const skills = await service.list("humanised");
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("humanised-client-report-commentary");
  });
});

describe("load", () => {
  it("returns SKILL.md plus a file listing by default", async () => {
    const loaded = await service.load("report-design-system");
    expect(loaded.content).toContain("# Genesis Report Design System");
    const paths = loaded.files?.map((file) => file.path) ?? [];
    expect(paths).toContain("aib-ni/layout-spec.md");
    expect(paths).toContain("aib-ni/theme.json");
    const pptx = loaded.files?.find((file) => file.path === "aib-ni/reference.pptx");
    expect(pptx?.loadable).toBe(false);
    expect(paths).not.toContain("aib-ni/.env");
  });

  it("loads a support file inside the skill folder", async () => {
    const loaded = await service.load("report-design-system", "aib-ni/theme.json");
    expect((JSON.parse(loaded.content) as { brand: string }).brand).toBe("51005B");
    expect(loaded.files).toBeUndefined();
  });

  it("rejects unknown skills", async () => {
    await expect(service.load("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects binary support files", async () => {
    await expect(service.load("report-design-system", "aib-ni/reference.pptx")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects protected paths", async () => {
    await expect(service.load("report-design-system", "aib-ni/.env")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects path traversal", async () => {
    await expect(service.load("report-design-system", "../outside.md")).rejects.toBeInstanceOf(WorkspaceError);
  });

  it("rejects symlinks that escape the root", async () => {
    await expect(service.load("report-design-system", "aib-ni/escape.md")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects allowed-extension symlinks that resolve to protected files inside the root", async () => {
    await expect(service.load("report-design-system", "aib-ni/notes.md")).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects allowed-extension symlinks that resolve to binary files inside the root", async () => {
    await expect(service.load("report-design-system", "aib-ni/deck.md")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects text-extension files containing binary data", async () => {
    await expect(service.load("report-design-system", "aib-ni/garbled.md")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("truncates oversized files", async () => {
    const small = new SkillsService(root, 10);
    const loaded = await small.load("report-design-system");
    expect(loaded.truncated).toBe(true);
    expect(loaded.content).toHaveLength(10);
  });
});
