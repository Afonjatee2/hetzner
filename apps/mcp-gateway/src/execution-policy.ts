import { access } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ExecutionMode } from "@gpt-dev/schemas";

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn", "bun"]);
const PREPARATION_COMMANDS = new Set([
  "install", "i", "add", "fetch", "config", "store", "setup", "env", "self-update"
]);
const INFORMATION_FLAGS = new Set(["--version", "-v", "--help", "-h", "help"]);
const DEPENDENCY_MARKERS = ["node_modules", ".pnp.cjs", ".pnp.loader.mjs"];

export function requiresPreparedNodeDependencies(
  runtime: "node" | "python" | "generic",
  mode: ExecutionMode,
  executable: string,
  args: string[]
): boolean {
  if (runtime !== "node" || mode === "host") return false;
  if (!PACKAGE_MANAGERS.has(basename(executable))) return false;
  const first = args[0] ?? "";
  return !PREPARATION_COMMANDS.has(first) && !INFORMATION_FLAGS.has(first);
}

export async function hasPreparedNodeDependencies(worktreePath: string): Promise<boolean> {
  for (const marker of DEPENDENCY_MARKERS) {
    try {
      await access(join(worktreePath, marker));
      return true;
    } catch {
      // Check the next supported dependency marker.
    }
  }
  return false;
}
