import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertNonMutatingGitCommand, createElectronEnvironment, hasPreparedNodeDependencies,
  requiresPreparedNodeDependencies, resolveTaskCheckPreset
} from "./execution-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("requiresPreparedNodeDependencies", () => {
  it("blocks package scripts in an unprepared Node container", () => {
    expect(requiresPreparedNodeDependencies("node", "container", "pnpm", ["lint"])).toBe(true);
    expect(requiresPreparedNodeDependencies("node", "container", "npm", ["run", "test"])).toBe(true);
  });

  it("allows preparation and information commands", () => {
    expect(requiresPreparedNodeDependencies("node", "container", "pnpm", ["install"])).toBe(false);
    expect(requiresPreparedNodeDependencies("node", "container", "pnpm", ["--version"])).toBe(false);
  });

  it("does not restrict host execution or non-Node projects", () => {
    expect(requiresPreparedNodeDependencies("node", "host", "pnpm", ["lint"])).toBe(false);
    expect(requiresPreparedNodeDependencies("generic", "container", "pnpm", ["lint"])).toBe(false);
  });
});

describe("hasPreparedNodeDependencies", () => {
  it("recognises node_modules and Yarn PnP markers", async () => {
    const withModules = await mkdtemp(join(tmpdir(), "prepared-modules-"));
    temporaryDirectories.push(withModules);
    await mkdir(join(withModules, "node_modules"));
    expect(await hasPreparedNodeDependencies(withModules)).toBe(true);

    const withPnp = await mkdtemp(join(tmpdir(), "prepared-pnp-"));
    temporaryDirectories.push(withPnp);
    await writeFile(join(withPnp, ".pnp.cjs"), "");
    expect(await hasPreparedNodeDependencies(withPnp)).toBe(true);
  });

  it("returns false when no dependency marker exists", async () => {
    const empty = await mkdtemp(join(tmpdir(), "unprepared-"));
    temporaryDirectories.push(empty);
    expect(await hasPreparedNodeDependencies(empty)).toBe(false);
  });
});

describe("attached command presets", () => {
  it("resolves only fixed argv for standard checks", async () => {
    expect(await resolveTaskCheckPreset("/unused", "git-diff-check"))
      .toEqual({ executable: "git", args: ["diff", "--check"] });
    expect(await resolveTaskCheckPreset("/unused", "tests"))
      .toEqual({ executable: "pnpm", args: ["test"] });
    expect(() => assertNonMutatingGitCommand({ executable: "git", args: ["reset", "--hard"] }))
      .toThrow(/Git-changing/);
    expect(() => assertNonMutatingGitCommand({ executable: "pnpm", args: ["exec", "git", "clean", "-fd"] }))
      .toThrow(/Git-changing/);
    expect(() => assertNonMutatingGitCommand({ executable: "npx", args: ["git", "switch", "main"] }))
      .toThrow(/Git-changing/);
    expect(() => assertNonMutatingGitCommand({ executable: "node", args: ["--eval", "process.exit()"] }))
      .toThrow(/Inline host code/);
  });

  it("validates project-defined Electron argv and creates isolated environment roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "electron-preset-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({
      gptdev: { electronAcceptance: ["node", "acceptance.mjs"] }
    }));
    expect(await resolveTaskCheckPreset(root, "electron-acceptance"))
      .toEqual({ executable: "node", args: ["acceptance.mjs"] });
    const artifactRoot = join(root, "execution");
    const env = await createElectronEnvironment(artifactRoot);
    for (const key of [
      "HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "TMPDIR",
      "ELECTRON_USER_DATA_DIR", "GPTDEV_SCREENSHOTS_DIR", "GPTDEV_TRACES_DIR", "GPTDEV_LOGS_DIR"
    ]) {
      expect(env[key]).toMatch(new RegExp(`^${artifactRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`));
      expect(await import("node:fs/promises").then(({ stat }) => stat(env[key]!))).toBeTruthy();
    }
  });

  it("rejects shell and malformed Electron acceptance definitions", async () => {
    const root = await mkdtemp(join(tmpdir(), "electron-invalid-"));
    temporaryDirectories.push(root);
    await writeFile(join(root, "package.json"), JSON.stringify({
      gptdev: { electronAcceptance: ["sh", "-c", "git reset --hard"] }
    }));
    await expect(resolveTaskCheckPreset(root, "electron-acceptance"))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
