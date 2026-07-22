import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasPreparedNodeDependencies, requiresPreparedNodeDependencies } from "./execution-policy.js";

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
